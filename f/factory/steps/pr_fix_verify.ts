// f/factory/pr_fixの検証ステップ。
// `pr_fix_apply.ts`の修正をpushしてよいかを、禁止された変更の検出と
// 検査コマンドで確かめる。

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
import {
  lockJobIdFromEnv,
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
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
  listUncommittedChangedPaths,
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

/**
 * worktreeの変更に、禁止されたファイル・パターン、symlink、
 * `package.json`のscriptsの変更、差分サイズの上限超過が無いかを調べて返す。
 * gitはhook・fsmonitor・credential helperを無効にして実行する。
 */
async function checkForbidden(
  worktreeDir: string,
  maxChangedFiles: number,
  maxDiffLines: number,
): Promise<ForbiddenChangeResult> {
  const changedPaths = await listUncommittedChangedPaths(
    runCommand,
    worktreeDir,
  );

  // basenameがちょうど`package.json`の変更ファイルをすべて調べる。
  // 末尾一致だと`my-package.json`のような別ファイルにも当たるため使わない。
  const packageJsonChanged = await anyPackageJsonScriptsChanged(
    runCommand,
    worktreeDir,
    "HEAD",
    changedPaths,
  );

  // worktreeの外を指すsymlinkの変更を止める。
  // それに加え、外を指すかどうかに関わらず、symlinkの作成・変更・型の変更を
  // すべて止める(両方の検査を併用する)。
  // `detectSymlinkChanges`はsymlinkと通常ファイルの間の型の変更も捕まえる。
  // `listSymlinkTargets`のmode 120000のスナップショットだけでは、
  // symlink側が消えた後のこの変更を見逃す。
  const symlinkTargets = await listSymlinkTargets(
    runCommand,
    worktreeDir,
    changedPaths.map((entry) => entry.path),
  );
  const symlinkReasons = [
    ...detectEscapingSymlinks(worktreeDir, symlinkTargets),
    ...detectSymlinkChanges(changedPaths, symlinkTargets),
  ];

  // `factory_config.max_fix_changed_files` / `max_fix_diff_lines`を超える
  // ファイル数・行数を変えた修正を止める。
  // numstatはuntracked(新規追加)のファイルを含まないため、
  // ファイル数には禁止パスの検査と同じ`changedPaths.length`を使う。
  // 新規ファイルの行数もnumstatの合計に入らないため、
  // `countUntrackedFileLines`(`wc -l`で数え、gitに副作用を与えない)で足す。
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

/**
 * `pr_fix_apply.ts`が"done"を返したとき、修正をpushしてよいかを検証して結果を返す。
 * 先に禁止された変更を検出し、見つかれば無条件に"blocked"にする。
 * 通ったときだけ`factory_config.allowed_check_commands`を実行する
 * (最小限の環境変数で、秘密情報を渡さず、`mise trust`もしない)。
 * 検査が失敗したら、失敗の出力を添えてClaudeの修正を1回だけ追加で走らせ、
 * 禁止された変更の検出と検査をもう一度行う。
 * それでも失敗する(または禁止された変更がある)ときは"blocked"にする。
 * `pr_fix_apply.ts`がrequirements_gapかblockedを返したときは、
 * Claudeがcommitを作らないと判断したため検証するものが無く、そのまま返す。
 */
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
  const lockedRun = withWorktreeProcessLock(
    runCommand,
    worktreeLockFor(worktree_dir),
    {
      kind: "pr_fix",
      workItemId: work_item_id,
      jobId: lockJobIdFromEnv(process.env),
    },
  );
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

  // `allowed_check_commands`は、対象リポジトリの検証されていないコードを、
  // worker内でサンドボックスなしにroot権限で実行する。
  // この常設リスクを記録に残らないままにせずNoticesの画面に見え続けるよう、
  // 1日1回ではなく実行のたびにnoticeを記録する。
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
    lockedRun,
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

  // 2回目のClaude呼び出しの前に、`pipeline_generate.ts`と同じ日次予算の検査をする。
  // `pr_fix_apply.ts`の予算検査と同じく"blocked"を返し、
  // `pr_fix_finish.ts`のneeds_humanの処理に乗せる。
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

  // 検査の失敗出力を添えて、Claudeの修正を1回だけ再実行する。
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
    // 検査の失敗出力は対象リポジトリ由来の信頼できない内容なので、
    // 他の同種の内容と同じく`fixPrompt`がフェンスで囲む。
    // ここで素のテキストとして足さない。
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
      run: lockedRun,
      workItemId: work_item_id,
      stage: "pr_fix_verify_retry",
      attempt,
      model: config.model,
      prompt: retryPrompt,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: FIX_SCHEMA,
      isStructuredOutput: isFixClaudeOutput,
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      // `pr_fix_apply.ts`と同じ設定。
      // 実測で編集と書き込みが通ったのは、"acceptEdits"ではなく
      // "dontAsk"に`--allowedTools Edit Write`を組み合わせたときだった。
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
      lockedRun,
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

    // 再実行でもコミットの件名と本文はClaudeの提案で、形は`isFixClaudeOutput`が検証済み。
    // `retryOutput.outcome`が"done"なので、ここではnullにならない。
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
