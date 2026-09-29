// PathScript step for f/factory/pr_fix: when pr_fix_apply.ts reported
// "done", verifies the change is safe to push — forbidden-file/pattern
// detection (docs/security.md "変更してはいけないファイル") runs first and
// unconditionally blocks; only then are factory_config.allowed_check_commands
// run (minimal env, no secrets, no mise trust). On a check failure, runs
// ONE more Claude fix pass with the failing check output appended, then
// re-verifies (forbidden-check + checks) once more — still failing (or
// still forbidden) ends in "blocked". requirements_gap/blocked from
// pr_fix_apply.ts pass through unchanged (Claude decided not to produce a
// commit at all, so there's nothing to verify).
//
// team-lead decision (2026-09-26): main() no longer takes a `fix_round`
// parameter, for the same reason as pr_fix_apply.ts's own — Claude proposes
// `commit_subject`/`commit_body` directly now (FIX_SCHEMA), so the retry
// pass below just passes those through instead of deriving one from
// `fix_round`.

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { addNotice, latestDraft, recordAgentRun } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import { FIX_SCHEMA, fixPrompt } from "../lib/prompts.ts";
import type { FixOutcome, FixReply } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  anyPackageJsonScriptsChanged,
  type CollectedComment,
  type CollectedReview,
  countUntrackedFileLines,
  detectEscapingSymlinks,
  detectForbiddenChanges,
  detectSymlinkChanges,
  evaluateDiffSizeGuard,
  type ForbiddenChangeResult,
  getDiffNumstat,
  isFixClaudeOutput,
  listSymlinkTargets,
  mergeChangedPaths,
  parseGitDiffNameOnly,
  parseGitStatusPorcelain,
  runAllowedCheckCommands,
  sumDiffNumstatLines,
} from "./pr_workflow_support.ts";

export type PrFixVerifyResult = {
  readonly outcome: FixOutcome;
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

function localGitEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const home = process.env.HOME;
  if (home !== undefined) env.HOME = home;
  const path = process.env.PATH;
  if (path !== undefined) env.PATH = path;
  return env;
}

async function checkForbidden(
  worktreeDir: string,
  maxChangedFiles: number,
  maxDiffLines: number,
): Promise<ForbiddenChangeResult> {
  const [statusResult, diffResult] = await Promise.all([
    runCommand(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "status",
        "--porcelain",
      ],
      { cwd: worktreeDir, env: localGitEnv() },
    ),
    runCommand(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "diff",
        "--name-only",
      ],
      { cwd: worktreeDir, env: localGitEnv() },
    ),
  ]);
  const changedPaths = mergeChangedPaths(
    parseGitStatusPorcelain(statusResult.stdout),
    parseGitDiffNameOnly(diffResult.stdout),
  );

  // team-lead fix round 1b item 4: check every changed file whose basename
  // is exactly "package.json" (was: only the first `.endsWith("package.json")`
  // match, which both stopped at one file and could false-match e.g.
  // "my-package.json").
  const packageJsonChanged = await anyPackageJsonScriptsChanged(
    runCommand,
    worktreeDir,
    "HEAD",
    changedPaths,
  );

  // team-lead fix round 1b item 3: block a changed symlink that resolves
  // outside the worktree. team-lead security re-gate N1/N6 (superset, kept
  // alongside): block every symlink creation/modification/typechange
  // unconditionally, not just an escaping one — detectSymlinkChanges also
  // catches a symlink<->regular-file typechange, which listSymlinkTargets's
  // mode-120000 snapshot alone would miss once the symlink side is gone.
  const symlinkTargets = await listSymlinkTargets(
    runCommand,
    worktreeDir,
    changedPaths.map((entry) => entry.path),
  );
  const symlinkReasons = [
    ...detectEscapingSymlinks(worktreeDir, symlinkTargets),
    ...detectSymlinkChanges(changedPaths, symlinkTargets),
  ];

  // team-lead fix round 1b item 7: block a fix pass that touches more files
  // or lines than factory_config.max_fix_changed_files / max_fix_diff_lines
  // allow. changedPaths.length (the same status+diff-name-only union used
  // for the forbidden-path check above) is used for the file count rather
  // than a count derived from numstat alone, since numstat omits untracked
  // (newly added) files. Their line counts are similarly missing from
  // numstat's total — team-lead fix round 2 item 7 addendum: added via
  // countUntrackedFileLines (wc -l, no git side effect) instead.
  const numstatEntries = await getDiffNumstat(runCommand, worktreeDir);
  const addedEntries = changedPaths.filter((entry) => entry.status === "added");
  const untrackedLineCounts = await Promise.all(
    addedEntries.map((entry) =>
      countUntrackedFileLines(runCommand, worktreeDir, entry.path),
    ),
  );
  const untrackedLineTotal = untrackedLineCounts.reduce((a, b) => a + b, 0);
  const diffSizeReasons = evaluateDiffSizeGuard(
    changedPaths.length,
    sumDiffNumstatLines(numstatEntries) + untrackedLineTotal,
    maxChangedFiles,
    maxDiffLines,
  );

  return detectForbiddenChanges(changedPaths, packageJsonChanged, [
    ...symlinkReasons,
    ...diffSizeReasons,
  ]);
}

export async function main(
  work_item_id: number,
  owner: string,
  repo: string,
  pr_number: number,
  apply_outcome: FixOutcome,
  apply_reason: string | null,
  apply_summary: string,
  apply_replies: FixReply[],
  apply_commit_subject: string | null,
  apply_commit_body: string | null,
  worktree_dir: string,
  factory_clone_dir: string,
  parent_work_item_id: number | null,
  attempt: number,
  reviews: CollectedReview[],
  comments: CollectedComment[],
): Promise<PrFixVerifyResult> {
  if (apply_outcome !== "done") {
    return {
      outcome: apply_outcome,
      reason: apply_reason,
      summary: apply_summary,
      replies: apply_replies,
      commit_subject: null,
      commit_body: null,
    };
  }

  const log = logger("pr_fix_verify");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // team-lead fix round 1b item 2: allowed_check_commands runs untrusted
  // target-repo code as root inside the worker with no sandbox isolation —
  // record a notice every time this is about to happen (not just once a
  // day), so it stays visible in the Notices view rather than being an
  // undocumented standing risk.
  if (config.allowed_check_commands.length > 0) {
    await addNotice({
      kind: "unsandboxed_check_commands",
      message: `pr_fix_verify はこれから ${String(config.allowed_check_commands.length)} 件の allowed_check_commands を、サンドボックス分離なしで root 権限により ${owner}/${repo}#${String(pr_number)} の未検証コードに対して実行します(work item ${String(work_item_id)})。`,
    });
  }

  const forbidden = await checkForbidden(
    worktree_dir,
    config.max_fix_changed_files,
    config.max_fix_diff_lines,
  );
  if (forbidden.blocked) {
    return {
      outcome: "blocked",
      reason: forbidden.reasons.join("; "),
      summary: apply_summary,
      replies: apply_replies,
      commit_subject: null,
      commit_body: null,
    };
  }
  const timeoutMs = config.claude_timeout_sec * 1000;

  if (config.allowed_check_commands.length === 0) {
    return {
      outcome: "done",
      reason: null,
      summary: apply_summary,
      replies: apply_replies,
      commit_subject: apply_commit_subject,
      commit_body: apply_commit_body,
    };
  }

  const firstChecks = await runAllowedCheckCommands(
    runCommand,
    worktree_dir,
    config.allowed_check_commands,
    timeoutMs,
  );
  if (firstChecks.every((result) => result.ok)) {
    return {
      outcome: "done",
      reason: null,
      summary: apply_summary,
      replies: apply_replies,
      commit_subject: apply_commit_subject,
      commit_body: apply_commit_body,
    };
  }

  // team-lead fix round 1b item 3 / fix round 2 item b: same daily-budget
  // guard as pipeline_generate.ts (lib/claude.ts's dailyBudgetStatus, same
  // exceeded check and log.warn shape), before this second Claude call —
  // "blocked" routes through pr_fix_finish.ts's existing needs_human
  // handling, same as pr_fix_apply.ts's own budget gate.
  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting the retry claude pass", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    return {
      outcome: "blocked",
      reason: `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
      summary: apply_summary,
      replies: apply_replies,
      commit_subject: null,
      commit_body: null,
    };
  }

  // One retry Claude pass with the check failure output appended.
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const client: GhClient = { run: runCommand, ghToken };
  const pr = await getPr(client, owner, repo, pr_number);
  const requirements =
    parent_work_item_id === null
      ? null
      : await latestDraft(parent_work_item_id);

  const retryPrompt = fixPrompt({
    pr: {
      owner,
      repo,
      number: pr_number,
      title: pr.title,
      body: pr.body,
      url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
      head_sha: pr.headSha,
      base_ref: pr.baseRef,
    },
    reviews,
    comments,
    requirements,
    // team-lead fix round 1b item 9: prompts.ts's fixPrompt now fences the
    // check-failure output itself (matching every other piece of untrusted
    // target-repo content) instead of this file appending
    // buildCheckFailureSection's plain-text section unfenced.
    checkFailures: firstChecks
      .filter((result) => !result.ok)
      .map((result) => ({
        command: result.command,
        outputTail: result.outputTail,
      })),
  });

  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-fix"],
    factoryCloneDir: factory_clone_dir,
  });

  try {
    const retryResult = await runClaude({
      run: runCommand,
      workItemId: work_item_id,
      stage: "pr_fix_verify_retry",
      attempt,
      model: config.model,
      prompt: retryPrompt,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: FIX_SCHEMA,
      isStructuredOutput: isFixClaudeOutput,
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      // Same fix as pr_fix_apply.ts (team-lead fix round 1b item 0,
      // superseded by fix round 2's measurement): "dontAsk" +
      // `--allowedTools Edit Write` is what was actually measured to allow
      // edits/writes, not "acceptEdits" alone.
      permissionMode: "dontAsk",
      allowedTools: ["Edit", "Write"],
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs,
    });

    await recordAgentRun(retryResult.agentRun);

    if (retryResult.outcome !== "success") {
      return {
        outcome: "blocked",
        reason: `check-fix retry pass failed (${retryResult.reason}): ${retryResult.detail}`,
        summary: apply_summary,
        replies: apply_replies,
        commit_subject: null,
        commit_body: null,
      };
    }

    const retryOutput = retryResult.structuredOutput;
    if (retryOutput.outcome !== "done") {
      return {
        outcome: retryOutput.outcome,
        reason: retryOutput.blocked_reason,
        summary: retryOutput.summary,
        replies: retryOutput.replies,
        commit_subject: null,
        commit_body: null,
      };
    }

    const forbiddenAfterRetry = await checkForbidden(
      worktree_dir,
      config.max_fix_changed_files,
      config.max_fix_diff_lines,
    );
    if (forbiddenAfterRetry.blocked) {
      return {
        outcome: "blocked",
        reason: forbiddenAfterRetry.reasons.join("; "),
        summary: retryOutput.summary,
        replies: retryOutput.replies,
        commit_subject: null,
        commit_body: null,
      };
    }

    const secondChecks = await runAllowedCheckCommands(
      runCommand,
      worktree_dir,
      config.allowed_check_commands,
      timeoutMs,
    );
    if (!secondChecks.every((result) => result.ok)) {
      return {
        outcome: "blocked",
        reason: "repository checks still failing after one automated fix retry",
        summary: retryOutput.summary,
        replies: retryOutput.replies,
        commit_subject: null,
        commit_body: null,
      };
    }

    // Claude proposed commit_subject/commit_body directly on this retry
    // pass too (isFixClaudeOutput's guard already validated their shape),
    // guaranteed non-null here since retryOutput.outcome === "done".
    return {
      outcome: "done",
      reason: null,
      summary: retryOutput.summary,
      replies: retryOutput.replies,
      commit_subject: retryOutput.commit_subject,
      commit_body: retryOutput.commit_body,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}
