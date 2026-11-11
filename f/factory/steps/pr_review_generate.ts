// f/factory/pr_reviewフローのレビュー生成ステップ。
// factory-reviewスキルと読み取り専用のツールでClaude Codeをヘッドレスで実行し、
// PRのdiff・変更ファイル・本文をレビューさせる。PRがFactoryの起こしたサイクルに
// 属するなら、承認済みの要件ドラフトも渡す。cwdは`pr_review_prepare.ts`が作った
// detachedのworktreeである。

import * as wmill from "windmill-client@1.817.0";
import { fixRoundOrNull } from "../lib/ci_fix_round.ts";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { recordClaudeRuns } from "../lib/claude_flow_failure.ts";
import { loadConfig } from "../lib/config.ts";
import {
  findFixRoundKindToReview,
  latestDraft,
  latestPostedPrReview,
  recordAgentRun,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import { flowFailureMessage } from "../lib/flow_retry_marker.ts";
import {
  type GhClient,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  limitReviewDiff,
  listReviewThreads,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { modelFor } from "../lib/model_policy.ts";
import { isAllowedLabeler, labelerPolicyFor } from "../lib/poll_support.ts";
import {
  REVIEW_MAX_FINDINGS,
  REVIEW_SCHEMA,
  reviewPrompt,
} from "../lib/prompts.ts";
import type {
  FileDiffHunks,
  ReviewFinding,
  ReviewVerdict,
  ThreadResponse,
} from "../lib/types.ts";
import {
  type ReviewDelta,
  readReviewDelta,
  runCommand,
} from "../lib/workspace.ts";
import {
  buildReviewDiffText,
  decideReviewScope,
  describeReason,
  hasBodyOnlyMustFinding,
  isReviewClaudeOutput,
  listReviewThreadsBestEffort,
  nextActionFor,
  type PriorReviewSha,
  prReviewTimeoutMisfit,
  reviewDeltaFromSha,
  reviewDeltaPaths,
  reviewMaxTurns,
  reviewOutputProseIssues,
  reviewThreadsForPrompt,
  selectListedBinaryFiles,
  settleReviewFindings,
  settleThreadResponses,
  splitChangedFiles,
  withTrustedResolution,
} from "./pr_workflow_support.ts";

export type PrReviewGenerateResult = {
  readonly skip: boolean;
  readonly budget_exceeded: boolean;
  readonly verdict: ReviewVerdict | null;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  /** 既存のスレッドへの答え。返信の前に、読み直したスレッドで確かめてから使う。 */
  readonly thread_responses: ThreadResponse[];
  readonly pr_files: string[];
  /** 変更ファイルごとの、行コメントを付けられる新しい側の行の範囲。投稿の前に、指摘の位置を確かめるのに使う。 */
  readonly pr_file_hunks: FileDiffHunks[];
  /** 差分に内容が出ないバイナリのファイル。投稿の本文に、決定的な固定の文で載せる。 */
  readonly binary_files: readonly string[];
  /** `binary_files`に載せなかった(パスを変更ファイルと照合できなかった)バイナリの件数。 */
  readonly binary_unlisted_count: number;
};

const SKIPPED_RESULT: PrReviewGenerateResult = {
  skip: true,
  budget_exceeded: false,
  verdict: null,
  summary: "",
  findings: [],
  thread_responses: [],
  pr_files: [],
  pr_file_hunks: [],
  binary_files: [],
  binary_unlisted_count: 0,
};

export async function main(
  work_item_id: number,
  skip: boolean,
  owner: string,
  repo: string,
  pr_number: number,
  review_sha: string,
  worktree_dir: string,
  factory_clone_dir: string,
  parent_work_item_id: number | null,
  attempt: number,
): Promise<PrReviewGenerateResult> {
  if (skip) {
    return SKIPPED_RESULT;
  }

  const log = logger("pr_review_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const client: GhClient = { run: runCommand, ghToken };

  /**
   * Claudeを起動せずに作業項目を`reviewing`から`needs_human`へ遷移させ、遷移できたらDiscordへ通知する。
   * pr_reviewには投稿しなかった結果を扱う後続ステップが無いため、`pr_review_post.ts`に回さずここで行う。
   * `statusReason`は記録する理由、`displayReason`は通知の表示と次の操作を選ぶ理由である。
   * 通知の失敗は警告を記録するだけで投げない。
   */
  async function moveToNeedsHuman(
    statusReason: string,
    displayReason: string,
  ): Promise<void> {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "reviewing",
      "needs_human",
      statusReason,
    );
    if (!moved) return;
    // トリガーの`review_label`は確保の時点で`poll_prs.ts`が外しているので、
    // ここで外すラベルは無い。
    const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
    const event: NotifyEvent = {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
      reason: describeReason(displayReason),
      target: { kind: "pr", number: pr_number },
      next_action: nextActionFor(displayReason),
    };
    await notifyBestEffort(webhookUrl, event, log);
  }

  // 生成ステップの最悪の所要時間がflow.yamlのtimeoutに収まらない設定では、
  // Windmillがアプリ側のtimeoutより先にステップを打ち切るため、Claudeを起動しない。
  const timeoutMisfit = prReviewTimeoutMisfit(config);
  if (timeoutMisfit !== null) {
    log.warn("time settings do not fit the step timeout, not starting claude", {
      work_item_id,
      reason: timeoutMisfit,
    });
    await moveToNeedsHuman(timeoutMisfit, timeoutMisfit);
    return SKIPPED_RESULT;
  }

  // Claudeを呼ぶ前に、`pipeline_generate.ts`と同じ日次予算の検査をする
  // (`lib/claude.ts`の`dailyBudgetStatus`を使い、超過の判定とログの形も同じ)。
  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    await moveToNeedsHuman(
      `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
      "daily budget exceeded",
    );
    return { ...SKIPPED_RESULT, budget_exceeded: true };
  }

  // スレッドの一覧は、再レビューで重複を避けるプロンプトの材料にすぎない。
  // 読めないとき(1000件超、形の不一致など)に生成を止めると、再試行しても直らずレビューが投稿されない。
  // 空で続けても、未解決の`[MUST]`の誤判定は投稿ステップが一覧を読み直して防ぐ。
  // 変更ファイルの一覧は、`patch`の文字列を持たない形に分けて受ける。Claudeの実行のあいだ、大きな文字列を持たないためである。
  const [
    pr,
    prDiff,
    { entries: prFileEntries, hunks: prFileHunks },
    viewer,
    listedThreads,
  ] = await Promise.all([
    getPr(client, owner, repo, pr_number),
    getPrDiff(client, owner, repo, pr_number, config.diff_max_lines),
    getPrFiles(client, owner, repo, pr_number).then(splitChangedFiles),
    getViewer(client),
    listReviewThreadsBestEffort(
      () => listReviewThreads(client, owner, repo, pr_number),
      (message) => {
        log.warn("failed to list review threads, continuing without", {
          work_item_id,
          error: message,
        });
      },
    ),
  ]);
  const prFiles = prFileEntries.map((entry) => entry.filename);
  // 差分の行から取り出したパスは、APIの変更ファイルに載るものだけをClaudeに読ませる。
  // 載らないものは、件数だけを投稿に残す。
  const { listed: binaryFiles, unlistedCount: binaryUnlistedCount } =
    selectListedBinaryFiles(prDiff.binaryFiles, prFiles);

  const requirements =
    parent_work_item_id === null
      ? null
      : await latestDraft(parent_work_item_id);

  // `threadResponseKind`が、許可された人の返信を見分けるのに使う。
  const labelerPolicy = labelerPolicyFor(viewer.login, config);
  const isAllowedReplier = (login: string, id: number | null): boolean =>
    isAllowedLabeler(login, labelerPolicy, id);
  // 許可されていない人が解決したスレッドは、この先すべてで未解決として扱う。
  const reviewThreads = withTrustedResolution(
    listedThreads,
    viewer.login,
    isAllowedReplier,
  );
  // 再レビューで、同じ指摘を出し直させず、見送りの返信を読ませるために渡す。
  const promptThreads = reviewThreadsForPrompt(
    reviewThreads,
    viewer.login,
    isAllowedReplier,
  );

  // レビューするcommitが、CI回か競合回のpushしたcommitなら、その差分を重点的に見るようプロンプトに加える。
  // 値はDBから決めた回の種類だけで、PRの内容からは決めない。
  // 問い合わせに失敗しても通常のレビューは止めない。nullに倒して警告を残す。
  const fixRound = await fixRoundOrNull(
    () => findFixRoundKindToReview(owner, repo, pr_number, review_sha),
    (message) =>
      log.warn("could not look up the fix round kind, reviewing without it", {
        work_item_id,
        error: message,
      }),
  );

  // 前回の投稿が読めないときも、PR全体のレビューに倒して止めない。
  let prior: PriorReviewSha;
  let priorFindings: readonly ReviewFinding[] = [];
  try {
    const posted = await latestPostedPrReview(owner, repo, pr_number);
    if (posted === null) {
      prior = { kind: "none" };
    } else {
      prior = { kind: "found", sha: posted.head_sha };
      priorFindings = posted.findings;
    }
  } catch (err) {
    log.warn("could not read the prior review commit, reviewing the whole PR", {
      work_item_id,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    prior = { kind: "unreadable" };
  }
  const scopeInput = {
    prior,
    headSha: review_sha,
    fixRound,
    pendingSkipCount: promptThreads.threads.filter(
      (thread) => thread.response_kind === "skip",
    ).length,
    hasBodyOnlyMust: hasBodyOnlyMustFinding(
      priorFindings,
      reviewThreads,
      viewer.login,
    ),
    changedFileCount: prFiles.length,
  };
  let delta: ReviewDelta | null = null;
  const deltaFromSha = reviewDeltaFromSha(scopeInput);
  if (deltaFromSha !== null) {
    try {
      delta = await readReviewDelta({
        run: runCommand,
        dir: worktree_dir,
        fromSha: deltaFromSha,
        headSha: review_sha,
        paths: reviewDeltaPaths(prFileEntries),
      });
    } catch (err) {
      log.warn("could not read the changes since the prior review", {
        work_item_id,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  const scope = decideReviewScope({ ...scopeInput, delta });
  log.info("review scope", {
    work_item_id,
    scope: scope.kind,
    ...(scope.kind === "full" ? { reason: scope.reason } : {}),
  });
  const deltaDiff =
    scope.kind === "delta" && delta !== null
      ? limitReviewDiff(delta.diff, config.diff_max_lines)
      : null;
  const diffText =
    scope.kind === "threads_only"
      ? "(no new commits)"
      : buildReviewDiffText(deltaDiff ?? prDiff);

  const promptText = reviewPrompt({
    pr: {
      owner,
      repo,
      number: pr_number,
      title: pr.title,
      body: pr.body,
      url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
      head_sha: review_sha,
      base_ref: pr.baseRef,
    },
    diff: diffText,
    changedFiles: prFiles,
    requirements,
    threads: promptThreads.threads,
    omittedThreadCount: promptThreads.omitted,
    scope,
    fixRound,
    // 差分に現れたバイナリだけを読ませる。総評の一覧(`binary_files`)はPR全体のままにする。
    binaryFiles:
      deltaDiff === null
        ? binaryFiles
        : selectListedBinaryFiles(deltaDiff.binaryFiles, prFiles).listed,
  });

  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-review"],
    factoryCloneDir: factory_clone_dir,
  });

  try {
    const result = await runClaude({
      run: runCommand,
      workItemId: work_item_id,
      stage: "pr_review",
      attempt,
      model: modelFor(config, "pr_review", 0),
      prompt: promptText,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: REVIEW_SCHEMA,
      isStructuredOutput: isReviewClaudeOutput,
      tools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
      settingSources: ["user"],
      maxTurns: reviewMaxTurns(scope, config),
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
    });

    await recordClaudeRuns(result, recordAgentRun);

    if (result.outcome !== "success") {
      throw new Error(
        flowFailureMessage(
          result.reason,
          `pr_review_generate: claude run failed (${result.reason}): ${result.detail}`,
        ),
      );
    }

    const output = result.structuredOutput;
    const proseIssues = reviewOutputProseIssues(output);
    if (proseIssues.length > 0) {
      log.warn("review output breaks the writing rules", {
        work_item_id,
        issues: proseIssues,
      });
    }
    const { summary, findings } = settleReviewFindings(
      output,
      scope,
      REVIEW_MAX_FINDINGS,
    );

    return {
      skip: false,
      budget_exceeded: false,
      verdict: output.verdict,
      summary,
      findings,
      thread_responses: settleThreadResponses(output.thread_responses, scope),
      pr_files: prFiles,
      pr_file_hunks: prFileHunks,
      binary_files: binaryFiles,
      binary_unlisted_count: binaryUnlistedCount,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}
