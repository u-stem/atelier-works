// PathScript step for f/factory/pr_fix: runs headless Claude Code
// (factory-fix skill, tools Read/Glob/Grep/Edit/Write — no Bash,
// docs/security.md "pr_fix の安全策") in the gtr worktree pr_fix_prepare.ts
// built, addressing the reviews/comments pr_fix_collect.ts gathered.
//
// team-lead decision (2026-09-26): main() no longer takes a `fix_round`
// parameter — it used to feed the removed `buildFixCommitMessage`'s
// round-based fallback subject ("address round N review feedback") for a
// blank Claude summary; Claude now proposes `commit_subject`/`commit_body`
// directly (FIX_SCHEMA), so there is nothing left here to compute from it.

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { latestDraft, recordAgentRun } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import { FIX_SCHEMA, fixPrompt } from "../lib/prompts.ts";
import type { FixOutcome, FixReply } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  type CollectedComment,
  type CollectedReview,
  isFixClaudeOutput,
} from "./pr_workflow_support.ts";

export type PrFixApplyResult = {
  readonly outcome: FixOutcome;
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

export async function main(
  work_item_id: number,
  owner: string,
  repo: string,
  pr_number: number,
  head_sha: string,
  worktree_dir: string,
  factory_clone_dir: string,
  parent_work_item_id: number | null,
  attempt: number,
  reviews: CollectedReview[],
  comments: CollectedComment[],
): Promise<PrFixApplyResult> {
  const log = logger("pr_fix_apply");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // team-lead fix round 1b item 3 / fix round 2 item b: same daily-budget
  // guard as pipeline_generate.ts (lib/claude.ts's dailyBudgetStatus, same
  // exceeded check and log.warn shape). Returning "blocked" here (rather
  // than duplicating pipeline_generate.ts's inline status/label/comment/
  // notify sequence) reuses pr_fix_finish.ts's existing blocked ->
  // needs_human handling, the same way every other apply-time failure
  // already routes through it.
  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    return {
      outcome: "blocked",
      reason: `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    };
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const client: GhClient = { run: runCommand, ghToken };

  const pr = await getPr(client, owner, repo, pr_number);
  const requirements =
    parent_work_item_id === null
      ? null
      : await latestDraft(parent_work_item_id);

  const promptText = fixPrompt({
    pr: {
      owner,
      repo,
      number: pr_number,
      title: pr.title,
      body: pr.body,
      url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
      head_sha,
      base_ref: pr.baseRef,
    },
    reviews,
    comments,
    requirements,
    checkFailures: [],
  });

  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-fix"],
    factoryCloneDir: factory_clone_dir,
  });

  try {
    const result = await runClaude({
      run: runCommand,
      workItemId: work_item_id,
      stage: "pr_fix",
      attempt,
      model: config.model,
      prompt: promptText,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: FIX_SCHEMA,
      isStructuredOutput: isFixClaudeOutput,
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      // team-lead fix round 1b item 0, superseded by fix round 2's follow-up
      // measurement: "dontAsk" alone auto-denies Edit/Write (measured:
      // `{"edited":false,"written":false,"denied_reason":"write permission
      // was not granted"}`), and — contrary to the first fix's assumption —
      // "acceptEdits" was *also* measured to deny writes under `--add-dir`
      // paths. Only "dontAsk" + `--allowedTools Edit Write` (with
      // `--restricted`, always on) actually allowed edits/writes in that
      // measurement, so permissionMode stays "dontAsk" and allowedTools
      // narrows `tools` down to just the two pr_fix needs.
      permissionMode: "dontAsk",
      allowedTools: ["Edit", "Write"],
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
    });

    await recordAgentRun(result.agentRun);

    if (result.outcome !== "success") {
      throw new Error(
        `pr_fix_apply: claude run failed (${result.reason}): ${result.detail}`,
      );
    }

    const output = result.structuredOutput;
    return {
      outcome: output.outcome,
      // blocked_reason is populated for both "blocked" and
      // "requirements_gap" (FIX_SCHEMA), null for "done".
      reason: output.blocked_reason,
      summary: output.summary,
      replies: output.replies,
      // team-lead decision (2026-09-26): Claude proposes commit_subject/
      // commit_body directly now (isFixClaudeOutput's guard validates their
      // shape) — only meaningful when outcome is "done", same as before.
      commit_subject: output.outcome === "done" ? output.commit_subject : null,
      commit_body: output.outcome === "done" ? output.commit_body : null,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}
