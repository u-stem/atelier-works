// PathScript step for f/factory/pr_review: runs headless Claude Code
// (factory-review skill, read-only tools) against the PR's diff/changed
// files/body, plus the approved requirements draft when this PR belongs to
// a factory-driven cycle (spec-cycle2.md §3 M6, §7 item 2 — cwd is the
// detached worktree pr_review_prepare.ts built).

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  latestDraft,
  recordAgentRun,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  commentIssue,
  type GhClient,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  listReviewThreads,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { REVIEW_SCHEMA, reviewPrompt } from "../lib/prompts.ts";
import type { ReviewFinding, ReviewVerdict } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  buildReviewDiffText,
  describeReason,
  isReviewClaudeOutput,
  nextActionFor,
  openFindingsForPrompt,
  removeTerminalLabels,
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

  // team-lead fix round 1b item 3 / fix round 2 item b: same daily-budget
  // guard as pipeline_generate.ts (lib/claude.ts's dailyBudgetStatus, same
  // exceeded check and log.warn shape), run before any Claude call. Unlike
  // pipeline_generate.ts — whose caller (pipeline_decide.ts / on_error_flow)
  // has no separate "post the failure" step — pr_review has no downstream
  // step that handles a non-post outcome, so the needs_human status
  // transition, label removal, PR comment, and Discord notice all happen
  // right here rather than being deferred to pr_review_post.ts.
  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    const viewer = await getViewer(client);
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "reviewing",
      "needs_human",
      `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
    );
    if (moved) {
      await removeTerminalLabels(
        client,
        owner,
        repo,
        pr_number,
        [config.wip_label, config.review_label],
        log,
      );
      try {
        await commentIssue(
          client,
          owner,
          repo,
          pr_number,
          `pr_review-budget-${String(attempt)}`,
          work_item_id,
          "本日の Claude 利用予算の上限に達したため、レビューを保留しました。人による確認が必要です。",
          viewer.login,
        );
      } catch (err) {
        log.warn("failed to post pr_review budget-exceeded comment", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        try {
          const event: NotifyEvent = {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner,
            repo,
            url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
            reason: describeReason("daily budget exceeded"),
            target: { kind: "pr", number: pr_number },
            next_action: nextActionFor("daily budget exceeded"),
          };
          await notify(webhookUrl, event);
        } catch (err) {
          log.warn("discord notify failed", {
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }
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

  // team-lead decision (2026-09-26): a re-review must not re-post a finding
  // substantially the same as one that's already open — naturally empty on
  // a PR's first review, since no threads exist yet.
  const openFindings = openFindingsForPrompt(reviewThreads, viewer.login);

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
      model: config.model,
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

    await recordAgentRun(result.agentRun);

    if (result.outcome !== "success") {
      throw new Error(
        `pr_review_generate: claude run failed (${result.reason}): ${result.detail}`,
      );
    }

    const output = result.structuredOutput;
    const findings = output.findings.slice(0, MAX_FINDINGS);
    const summary =
      output.findings.length > MAX_FINDINGS
        ? `${output.summary}\n\n(優先度の低い指摘を ${String(output.findings.length - MAX_FINDINGS)} 件省略しました。)`
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
