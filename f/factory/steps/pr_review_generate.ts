// f/factory/pr_reviewフローのレビュー生成ステップ。
// factory-reviewスキルと読み取り専用のツールでClaude Codeをヘッドレスで実行し、
// PRのdiff・変更ファイル・本文をレビューさせる。PRがFactoryの起こしたサイクルに
// 属するなら、承認済みの要件ドラフトも渡す。cwdは`pr_review_prepare.ts`が作った
// detachedのworktreeである。

import * as wmill from "windmill-client@1.817.0";
import { ciRoundDiffOrFalse } from "../lib/ci_fix_round.ts";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  hasCiRoundDiffToReview,
  latestDraft,
  recordAgentRun,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  type GhClient,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  listReviewThreads,
} from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import { modelFor } from "../lib/model_policy.ts";
import { REVIEW_SCHEMA, reviewPrompt } from "../lib/prompts.ts";
import type { ReviewFinding, ReviewVerdict } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  buildReviewDiffText,
  describeReason,
  isReviewClaudeOutput,
  nextActionFor,
  openFindingsForPrompt,
  prReviewTimeoutMisfit,
  reviewOutputProseIssues,
} from "./pr_workflow_support.ts";

const MAX_FINDINGS = 20;

export type PrReviewGenerateResult = {
  readonly skip: boolean;
  readonly budget_exceeded: boolean;
  readonly verdict: ReviewVerdict | null;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly pr_files: string[];
};

const SKIPPED_RESULT: PrReviewGenerateResult = {
  skip: true,
  budget_exceeded: false,
  verdict: null,
  summary: "",
  findings: [],
  pr_files: [],
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

  const [pr, prDiff, prFileEntries, viewer, reviewThreads] = await Promise.all([
    getPr(client, owner, repo, pr_number),
    getPrDiff(client, owner, repo, pr_number, config.diff_max_lines),
    getPrFiles(client, owner, repo, pr_number),
    getViewer(client),
    listReviewThreads(client, owner, repo, pr_number),
  ]);
  const prFiles = prFileEntries.map((entry) => entry.filename);

  const requirements =
    parent_work_item_id === null
      ? null
      : await latestDraft(parent_work_item_id);

  // 再レビューで、未解決の指摘と実質的に同じ指摘を重ねて投稿させないために渡す。
  // 最初のレビューではスレッドがまだ無いので空になる。
  const openFindings = openFindingsForPrompt(reviewThreads, viewer.login);

  // レビューするcommitが、CI回のpushしたcommitなら、その差分を重点的に見るようプロンプトに加える。
  // 値はDBから決めた真偽値だけで、PRの内容からは決めない。
  // 問い合わせに失敗しても通常のレビューは止めない。偽に倒して警告を残す。
  const ciRoundDiff = await ciRoundDiffOrFalse(
    () => hasCiRoundDiffToReview(owner, repo, pr_number, review_sha),
    (message) =>
      log.warn("could not look up the CI round diff, reviewing without it", {
        work_item_id,
        error: message,
      }),
  );

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
    diff: buildReviewDiffText(prDiff),
    changedFiles: prFiles,
    requirements,
    openFindings,
    ciRoundDiff,
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
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
    });

    await recordClaudeRuns(result, recordAgentRun);

    if (result.outcome !== "success") {
      throw new Error(
        `pr_review_generate: claude run failed (${result.reason}): ${result.detail}`,
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
    const findings = output.findings.slice(0, MAX_FINDINGS);
    const summary =
      output.findings.length > MAX_FINDINGS
        ? `${output.summary}\n\n(優先度の低い指摘を${String(output.findings.length - MAX_FINDINGS)}件省略しました。)`
        : output.summary;

    return {
      skip: false,
      budget_exceeded: false,
      verdict: output.verdict,
      summary,
      findings,
      pr_files: prFiles,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}
