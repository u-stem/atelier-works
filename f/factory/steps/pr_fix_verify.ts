// f/factory/pr_fixの検証ステップ。
// `pr_fix_apply.ts`の修正をpushしてよいかを、禁止された変更の検出と
// 検査コマンドで確かめる。

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  type DailyBudgetStatus,
  dailyBudgetStatus,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { addNotice, latestDraft, recordAgentRun } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { escapeReasonSeparator, logger } from "../lib/log.ts";
import {
  lockJobIdFromEnv,
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { type CheckFailure, FIX_SCHEMA, fixPrompt } from "../lib/prompts.ts";
import type { FixOutcome, FixReply } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  runCommand,
  worktreeGitPointerMatches,
} from "../lib/workspace.ts";
import {
  type CheckCommandResult,
  type CollectedComment,
  type CollectedReview,
  claudeBlockedReason,
  type FixClaudeOutput,
  type ForbiddenChangeResult,
  inspectUncommittedChanges,
  isFixClaudeOutput,
  localHeadStopReason,
  PR_HEAD_NOT_RECORDED_REASON,
  recordedGitPointerStopReason,
  runAllowedCheckCommands,
  WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
} from "./pr_workflow_support.ts";

export type PrFixVerifyResult = {
  readonly outcome: FixOutcome;
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

/** 検査コマンドの失敗を添えたClaudeの再実行の結果。 */
export type PrFixRetryResult =
  | {
      readonly outcome: "failure";
      readonly reason: string;
      readonly detail: string;
    }
  | { readonly outcome: "success"; readonly output: FixClaudeOutput };

/** `runPrFixVerify`が使うI/O。テストでは偽物に差し替える。 */
export type PrFixVerifyDeps = {
  /** 検査コマンドをサンドボックスなしで実行することをnoticeに記録する。 */
  readonly announceChecks: () => Promise<void>;
  /** worktreeの`.git`を`expected`と比べ、違えば`WorktreeGitPointerModifiedError`を投げる。 */
  readonly assertGitPointer: (expected: string) => Promise<void>;
  /** worktreeのHEADが`expectedSha`でブランチ`branch`にあるかを確かめ、違えば理由を返す(`localHeadStopReason`)。 */
  readonly checkHead: (
    expectedSha: string,
    branch: string,
  ) => Promise<string | null>;
  /** コミットしていない変更を調べる(`inspectUncommittedChanges`)。gitを実行する。 */
  readonly inspectChanges: () => Promise<ForbiddenChangeResult>;
  /** `allowed_check_commands`を実行する。 */
  readonly runChecks: () => Promise<readonly CheckCommandResult[]>;
  readonly budgetStatus: () => Promise<DailyBudgetStatus>;
  /** 検査の失敗を添えてClaudeの修正を1回だけ再実行する。 */
  readonly runRetry: (
    failures: readonly CheckFailure[],
  ) => Promise<PrFixRetryResult>;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

export type PrFixVerifyInput = {
  /** 準備ステップが記録した`.git`の中身。準備ステップの結果に無ければnullか空文字列。 */
  readonly worktreeGitPointer: string | null;
  /** 準備ステップが見たPRのheadのsha。無ければnullか空文字列。 */
  readonly headSha: string | null;
  /** PRのheadブランチ。準備ステップの結果に無ければnullか空文字列。 */
  readonly branch: string | null;
  readonly hasCheckCommands: boolean;
  /** `pr_fix_apply.ts`が"done"で返した結果。 */
  readonly apply: {
    readonly summary: string;
    readonly replies: FixReply[];
    readonly commitSubject: string | null;
    readonly commitBody: string | null;
  };
};

/**
 * `pr_fix_apply.ts`が"done"を返した修正を、pushしてよいかを検証して結果を返す。
 * worktreeで変更を調べる前には毎回、`.git`が準備ステップの記録と一致することを確かめ、
 * 続けてHEADが記録したPRのheadでそのブランチにあることを確かめる(`checkHead`)。
 * 記録が無いか一致しなければ、変更を調べずに"blocked"にする。
 * 変わった`.git`の参照先が持ち込むconfigのfilter等を、次のgitがrootで実行するため。
 * HEADが動いていると、HEADを基準にした変更の一覧からローカルのcommitの変更が漏れるため。
 * 禁止された変更が見つかれば無条件に"blocked"にする。
 * 変更は、Claudeの実行の後と、検査コマンドが通った後(commitの直前)の両方で調べる。
 * 検査コマンドは対象リポジトリのコードで、保護パスのファイルやsymlinkを作れるため。
 * 検査が失敗したら、日次予算の範囲で、失敗の出力を添えてClaudeの修正を1回だけ追加で走らせ、
 * 変更の検査と検査コマンドをもう一度行う。それでも失敗するときは"blocked"にする。
 * 検査コマンドがあれば、準備ステップの記録がそろっていることを確かめた後、最初の検査の前に`announceChecks`を呼ぶ。
 * `assertGitPointer`が`WorktreeGitPointerModifiedError`以外を投げたときは、そのまま投げる。
 */
export async function runPrFixVerify(
  deps: PrFixVerifyDeps,
  input: PrFixVerifyInput,
): Promise<PrFixVerifyResult> {
  const blocked = (
    reason: string,
    summary: string,
    replies: FixReply[],
  ): PrFixVerifyResult => ({
    outcome: "blocked",
    reason,
    summary,
    replies,
    commit_subject: null,
    commit_body: null,
  });
  const pointer = input.worktreeGitPointer;
  if (pointer === null || pointer.length === 0) {
    return blocked(
      WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
      input.apply.summary,
      input.apply.replies,
    );
  }
  const headSha = input.headSha;
  const branch = input.branch;
  if (
    headSha === null ||
    headSha.length === 0 ||
    branch === null ||
    branch.length === 0
  ) {
    return blocked(
      PR_HEAD_NOT_RECORDED_REASON,
      input.apply.summary,
      input.apply.replies,
    );
  }
  // 検査コマンドがあるときは、準備ステップの記録がそろっていることを確かめた後、最初の検査より前に告知する。
  if (input.hasCheckCommands) await deps.announceChecks();
  /** `.git`とHEADを照合してから変更を調べ、止める理由を返す。問題が無ければnull。 */
  const inspect = async (): Promise<string | null> => {
    const pointerReason = await recordedGitPointerStopReason(
      pointer,
      deps.assertGitPointer,
    );
    if (pointerReason !== null) return pointerReason;
    const headReason = await deps.checkHead(headSha, branch);
    if (headReason !== null) return headReason;
    const forbidden = await deps.inspectChanges();
    // 理由のパスはClaudeや検査コマンドが選べるので、区切りで別の理由に見えないようにする。
    return forbidden.blocked
      ? forbidden.reasons.map(escapeReasonSeparator).join("; ")
      : null;
  };

  const firstReason = await inspect();
  if (firstReason !== null) {
    return blocked(firstReason, input.apply.summary, input.apply.replies);
  }
  const applyDone: PrFixVerifyResult = {
    outcome: "done",
    reason: null,
    summary: input.apply.summary,
    replies: input.apply.replies,
    commit_subject: input.apply.commitSubject,
    commit_body: input.apply.commitBody,
  };
  if (!input.hasCheckCommands) return applyDone;

  const firstChecks = await deps.runChecks();
  if (firstChecks.every((result) => result.ok)) {
    const afterChecksReason = await inspect();
    return afterChecksReason === null
      ? applyDone
      : blocked(afterChecksReason, input.apply.summary, input.apply.replies);
  }

  // `pr_fix_apply.ts`の予算検査と同じく"blocked"を返し、
  // `pr_fix_finish.ts`のneeds_humanの処理に乗せる。
  const budget = await deps.budgetStatus();
  if (budget.exceeded) {
    deps.warn("daily budget exceeded, not starting the retry claude pass", {
      spentToday: budget.spent_usd,
      dailyBudgetUsd: budget.limit_usd,
    });
    return blocked(
      `daily budget exceeded ($${budget.spent_usd.toFixed(2)} >= $${budget.limit_usd.toFixed(2)})`,
      input.apply.summary,
      input.apply.replies,
    );
  }

  // 検査コマンドの後、Claudeをもう一度起動する前にも`.git`を確かめる。
  // Claudeは起動時にcwdでgitを実行しうるため。
  const beforeRetryReason = await recordedGitPointerStopReason(
    pointer,
    deps.assertGitPointer,
  );
  if (beforeRetryReason !== null) {
    return blocked(beforeRetryReason, input.apply.summary, input.apply.replies);
  }
  const retry = await deps.runRetry(
    firstChecks
      .filter((result) => !result.ok)
      .map((result) => ({
        command: result.command,
        outputTail: result.outputTail,
      })),
  );
  if (retry.outcome === "failure") {
    // 失敗した実行が`.git`を書き換えていれば(不正な出力への再試行を`beforeRetry`が止めた場合を含む)、
    // Claudeの失敗ではなくポインタの書き換えを理由にする。
    const afterFailureReason = await recordedGitPointerStopReason(
      pointer,
      deps.assertGitPointer,
    );
    if (afterFailureReason !== null) {
      return blocked(
        afterFailureReason,
        input.apply.summary,
        input.apply.replies,
      );
    }
    return blocked(
      `check-fix retry pass failed (${retry.reason}): ${retry.detail}`,
      input.apply.summary,
      input.apply.replies,
    );
  }
  const output = retry.output;
  if (output.outcome !== "done") {
    return {
      outcome: output.outcome,
      reason: claudeBlockedReason(output.blocked_reason),
      summary: output.summary,
      replies: output.replies,
      commit_subject: null,
      commit_body: null,
    };
  }

  const afterRetryReason = await inspect();
  if (afterRetryReason !== null) {
    return blocked(afterRetryReason, output.summary, output.replies);
  }
  const secondChecks = await deps.runChecks();
  if (!secondChecks.every((result) => result.ok)) {
    return blocked(
      "repository checks still failing after one automated fix retry",
      output.summary,
      output.replies,
    );
  }
  const afterSecondChecksReason = await inspect();
  if (afterSecondChecksReason !== null) {
    return blocked(afterSecondChecksReason, output.summary, output.replies);
  }

  // 再実行でもコミットの件名と本文はClaudeの提案で、形は`isFixClaudeOutput`が検証済み。
  return {
    outcome: "done",
    reason: null,
    summary: output.summary,
    replies: output.replies,
    commit_subject: output.commit_subject,
    commit_body: output.commit_body,
  };
}

/**
 * `pr_fix_apply.ts`が"done"を返したとき、修正をpushしてよいかを`runPrFixVerify`で検証して結果を返す。
 * 検査コマンドは最小限の環境変数で、秘密情報を渡さず、`mise trust`もせずに実行する。
 * `pr_fix_apply.ts`がrequirements_gapかblockedを返したときは、
 * Claudeがcommitを作らないと判断したため検証するものが無く、そのまま返す。
 * `worktree_git_pointer`・`head_sha`・`branch`は`pr_fix_prepare.ts`が記録した`.git`の中身、PRのheadのsha、headブランチ。
 * 準備ステップの結果にこれらが無いときは渡らないので、既定をnullにして"blocked"で止める。
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
  worktree_git_pointer: string | null = null,
  head_sha: string | null = null,
  branch: string | null = null,
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

  const timeoutMs = config.claude_timeout_sec * 1000;

  return await runPrFixVerify(
    {
      // `allowed_check_commands`は、対象リポジトリの検証されていないコードを、
      // worker内でサンドボックスなしにroot権限で実行する。
      // この常設リスクを記録に残らないままにせずNoticesの画面に見え続けるよう、
      // 1日1回ではなく実行のたびにnoticeを記録する。
      announceChecks: async () => {
        await addNotice({
          kind: "unsandboxed_check_commands",
          message: `pr_fix_verify はこれから ${String(config.allowed_check_commands.length)} 件の allowed_check_commands を、サンドボックス分離なしで root 権限により ${owner}/${repo}#${String(pr_number)} の未検証コードに対して実行します(work item ${String(work_item_id)})。`,
        });
      },
      assertGitPointer: (expected) =>
        assertWorktreeGitPointer(worktree_dir, expected),
      checkHead: (expectedSha, headBranch) =>
        localHeadStopReason(runCommand, worktree_dir, expectedSha, headBranch),
      inspectChanges: () =>
        inspectUncommittedChanges(runCommand, worktree_dir, {
          maxChangedFiles: config.max_fix_changed_files,
          maxDiffLines: config.max_fix_diff_lines,
        }),
      runChecks: () =>
        runAllowedCheckCommands(
          lockedRun,
          worktree_dir,
          config.allowed_check_commands,
          timeoutMs,
        ),
      budgetStatus: () => dailyBudgetStatus(config),
      runRetry: async (checkFailures) => {
        const ghToken = await wmill.getVariable("f/factory/github_token");
        const oauthToken = await wmill.getVariable(
          "f/factory/claude_oauth_token",
        );
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
          checkFailures,
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
            beforeRetry: () =>
              worktree_git_pointer === null
                ? Promise.resolve(false)
                : worktreeGitPointerMatches(worktree_dir, worktree_git_pointer),
          });
          await recordClaudeRuns(retryResult, recordAgentRun);
          return retryResult.outcome === "success"
            ? { outcome: "success", output: retryResult.structuredOutput }
            : {
                outcome: "failure",
                reason: retryResult.reason,
                detail: retryResult.detail,
              };
        } finally {
          await systemPrompt.cleanup();
        }
      },
      warn: (message, fields) => log.warn(message, { work_item_id, ...fields }),
    },
    {
      worktreeGitPointer: worktree_git_pointer,
      headSha: head_sha,
      branch,
      hasCheckCommands: config.allowed_check_commands.length > 0,
      apply: {
        summary: apply_summary,
        replies: apply_replies,
        commitSubject: apply_commit_subject,
        commitBody: apply_commit_body,
      },
    },
  );
}
