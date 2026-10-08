// f/factory/pr_fixの修正ステップ。
// `pr_fix_prepare.ts`が用意したworktreeでheadlessのClaude Codeを動かし、
// `pr_fix_collect.ts`が集めたレビューとコメントに対応させる。

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { latestDraft, recordAgentRun } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import {
  lockJobIdFromEnv,
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { FIX_SCHEMA, fixPrompt } from "../lib/prompts.ts";
import type { FixOutcome, FixReply } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  runCommand,
  worktreeGitPointerMatches,
} from "../lib/workspace.ts";
import {
  type CollectedComment,
  type CollectedReview,
  isFixClaudeOutput,
  recordedGitPointerStopReason,
  WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
} from "./pr_workflow_support.ts";

export type PrFixApplyResult = {
  readonly outcome: FixOutcome;
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

/**
 * factory-fixスキルでClaude Codeを実行し、修正の結果
 * (outcome、理由、要約、各コメントへの返信、コミットの件名と本文)を返す。
 * 使えるツールはRead/Glob/Grep/Edit/Writeに限り、Bashは渡さない。
 * コミットの件名と本文はClaudeが提案したものを使い、`outcome`が"done"のときだけ返す。
 * 日次予算を超えていればClaudeを起動せず"blocked"を返す。
 * worktreeの`.git`が`worktree_git_pointer`(準備ステップの記録)と一致しないとき、
 * 準備ステップの結果に`worktree_git_pointer`が無いときも、Claudeを起動せず"blocked"を返す。
 * 不正な出力への再試行の前にも`.git`を確かめ、一致しなければ再試行しない。
 * Claudeの実行が失敗したときは例外を投げる。
 */
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
  worktree_git_pointer: string | null = null,
): Promise<PrFixApplyResult> {
  const log = logger("pr_fix_apply");

  // Claudeは起動時にcwdでgitを実行しうるので、起動の前に`.git`を準備ステップの記録と比べる。
  // このステップの再試行(flow.yamlの`retry`)では、前の試行のClaudeが`.git`を書き換えた後でありうる。
  // 例外にするとフローの再試行がClaudeを起動し直すので、"blocked"を返す。
  const pointerReason = await recordedGitPointerStopReason(
    worktree_git_pointer,
    (expected) => assertWorktreeGitPointer(worktree_dir, expected),
  );
  if (pointerReason !== null || worktree_git_pointer === null) {
    return {
      outcome: "blocked",
      reason: pointerReason ?? WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    };
  }
  const recordedPointer = worktree_git_pointer;

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // `pipeline_generate.ts`と同じ日次予算の検査。
  // 状態遷移や通知をここで重複して書かず"blocked"を返すのは、
  // 修正時の他の失敗と同じく、`pr_fix_finish.ts`の
  // blockedからneeds_humanへの処理に乗せるため。
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
      run: withWorktreeProcessLock(runCommand, worktreeLockFor(worktree_dir), {
        kind: "pr_fix",
        workItemId: work_item_id,
        jobId: lockJobIdFromEnv(process.env),
      }),
      workItemId: work_item_id,
      stage: "pr_fix",
      attempt,
      model: config.model,
      prompt: promptText,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: FIX_SCHEMA,
      isStructuredOutput: isFixClaudeOutput,
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      // 実測では、"dontAsk"だけだとEdit/Writeが自動で拒否され
      // (`{"edited":false,"written":false,"denied_reason":"write permission
      // was not granted"}`)、"acceptEdits"でも`--add-dir`配下への書き込みが拒否された。
      // 編集と書き込みが通ったのは、"dontAsk"に`--allowedTools Edit Write`を
      // 組み合わせたとき(`--restricted`は常に有効)だけだった。
      // そのため`permissionMode`は"dontAsk"のままにし、
      // `allowedTools`でpr_fixに必要な2つに絞る。
      permissionMode: "dontAsk",
      allowedTools: ["Edit", "Write"],
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
      beforeRetry: () =>
        worktreeGitPointerMatches(worktree_dir, recordedPointer),
    });

    await recordClaudeRuns(result, recordAgentRun);

    if (result.outcome !== "success") {
      throw new Error(
        `pr_fix_apply: claude run failed (${result.reason}): ${result.detail}`,
      );
    }

    const output = result.structuredOutput;
    return {
      outcome: output.outcome,
      // `blocked_reason`は"blocked"と"requirements_gap"で値が入り、"done"ではnullになる。
      reason: output.blocked_reason,
      summary: output.summary,
      replies: output.replies,
      // 件名と本文はClaudeの提案で、形は`isFixClaudeOutput`が検証する。
      // 意味を持つのは`outcome`が"done"のときだけ。
      commit_subject: output.outcome === "done" ? output.commit_subject : null,
      commit_body: output.outcome === "done" ? output.commit_body : null,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}
