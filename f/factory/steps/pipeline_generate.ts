// PathScript step 2/4 of f/factory/pipeline (spec-cycle2.md §3 M6
// "generate_requirements"). Runs the daily budget guard, then headless
// Claude with the factory-requirements + drawio-diagram skills to produce a
// requirement draft, validates the structured output (via runClaude's own
// schema-checked retry) and each diagram's XML, saves the draft, and always
// records the agent_runs row (both on success and on failure).
//
// Diagrams that fail drawio.validateDrawioXml are dropped from the saved
// draft (with a warning log) rather than failing the whole run — draw.io
// diagrams are optional/supplementary per the drawio-diagram skill ("図が
// 不要な場合は空配列でよい"), so losing one bad diagram shouldn't waste an
// entire generation attempt. viewer URLs are intentionally not computed or
// stored here: factory.requirement_drafts.diagrams only ever holds
// `{name, drawio_xml}` (see lib/types.ts's Diagram type — no viewer_url
// field), and the viewer URL is instead derived on demand wherever a draft
// is rendered (pipeline_decide.ts's approve path, via
// lib/drawio.ts#renderIssueSection).
//
// [major, M6 review round 1] The daily budget guard's own
// isBudgetExceeded/jstMidnightTodayIso were local here at first; now
// promoted to lib/claude.ts's `dailyBudgetStatus`, so every caller reuses
// the same JST-midnight math and >= comparison.
//
// NOTE — runClaude-failure handling does no terminal transition here at
// all (see failGeneration's doc comment): pipeline__flow/flow.yaml's
// `generate` module now carries a `retry` (round 2, devil-advocate item 7,
// for transient Claude 429/5xx), and Windmill's own step retry re-invokes
// this whole script without checking work_items.status first. Round 2's
// first fix (consolidate the failure *notification* into on_error_flow,
// still doing status/label/comment here) turned out to still race with
// that retry (round 3, devil-advocate re-gate): failGeneration set status
// `failed` + removed labels + commented, then threw; if the retry then
// succeeded, request_approval moved the *same* work item on to
// `awaiting_approval` — now missing the trigger label, so the next
// poll_issues reconcile cancels it as if abandoned. So as of round 3, a
// runClaude failure does *only* `recordAgentRun` (already unconditional,
// above) and throws — no status/label/comment/notify — letting Windmill's
// retry re-attempt cleanly, and leaving every terminal transition (status,
// labels, notification, and — per impl-m5-poll — an Issue comment) to
// on_error_flow's failure_module alone, which only runs once retries are
// exhausted. The daily-budget-exceeded path below is unaffected: it
// returns (never throws), so Windmill's retry never fires for it.

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  latestDraft,
  recordAgentRun,
  saveDraft,
  updateStatus,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { validateDrawioXml } from "../lib/drawio.ts";
import {
  commentIssue,
  type GhClient,
  getViewer,
  removeLabel,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { REQUIREMENTS_SCHEMA, requirementsPrompt } from "../lib/prompts.ts";
import {
  type Diagram,
  type FactoryConfig,
  isRecord,
  isString,
  isStringArray,
} from "../lib/types.ts";
import { ensureFactoryClone, runCommand } from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

export type RequirementsOutput = {
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
};

export function isDiagram(value: unknown): value is Diagram {
  return isRecord(value) && isString(value.name) && isString(value.drawio_xml);
}

export function isRequirementsOutput(
  value: unknown,
): value is RequirementsOutput {
  if (!isRecord(value)) return false;
  if (!isString(value.summary) || !isString(value.markdown)) return false;
  if (!Array.isArray(value.diagrams) || !value.diagrams.every(isDiagram)) {
    return false;
  }
  if (!isStringArray(value.open_questions)) return false;
  return true;
}

/**
 * Normalizes `feedback` (pure, for testing). [major, M6 review round 1,
 * devil-advocate] This flow's callers other than pipeline_decide.ts's
 * reject-and-retry branch (poll_issues, retry_work_item,
 * manual_intake_register) don't pass `feedback` at all — the flow schema's
 * `default: ''` only applies when the flow is started through the UI/form,
 * not via `wmill.runFlowAsync`/the API, so a bare `feedback.length` here
 * would throw a TypeError on `null`/`undefined`. `null` / `undefined` /
 * empty string all mean "no feedback for this attempt".
 */
export function resolveFeedback(
  feedback: string | null | undefined,
): string | null {
  return feedback !== null && feedback !== undefined && feedback.length > 0
    ? feedback
    : null;
}

/** Drops any diagram whose XML fails lib/drawio.ts#validateDrawioXml,
 * calling `onInvalid` (a warning log, in production) for each one dropped.
 * Pure aside from that callback — the callback itself does no I/O in
 * tests. */
export function filterValidDiagrams(
  diagrams: readonly Diagram[],
  onInvalid: (diagram: Diagram, reason: string) => void = () => {},
): Diagram[] {
  return diagrams.filter((diagram) => {
    const validation = validateDrawioXml(diagram.drawio_xml);
    if (!validation.valid) {
      onInvalid(diagram, validation.reason);
    }
    return validation.valid;
  });
}

export type PipelineGenerateResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "budget_exceeded" };

async function notifySafe(
  webhookUrl: string,
  event: Parameters<typeof notify>[1],
): Promise<void> {
  if (webhookUrl.length === 0) return;
  await notify(webhookUrl, event);
}

/** Terminal transition: remove both wip and trigger labels (team-lead rule,
 * M5-review-derived) so a re-applied trigger label is what starts a fresh
 * cycle, rather than a needs_human/failed issue being silently reclaimed
 * forever by the next poll_issues run. */
async function removeTerminalLabels(
  client: GhClient,
  owner: string,
  repo: string,
  issueNumber: number,
  config: Pick<FactoryConfig, "wip_label" | "trigger_label">,
): Promise<void> {
  await removeLabel(client, owner, repo, issueNumber, config.wip_label);
  await removeLabel(client, owner, repo, issueNumber, config.trigger_label);
}

/**
 * [major, M6 review round 1, devil-advocate] Originally did the full
 * terminal transition here (status `failed`, Issue comment, label
 * removal) plus its own Discord `needs_human` notification, then still
 * threw — pipeline__flow's `failure_module` (on_error_flow) then ran too,
 * sending a *second*, differently-worded `job_failed` notification for the
 * same failure. Round 1's fix consolidated just the notification into
 * on_error_flow, keeping status/comment/labels here.
 *
 * [major, M6 review round 3, devil-advocate re-gate] That still wasn't
 * enough once round 2 added a step-level `retry` to the `generate` module
 * (pipeline__flow/flow.yaml, for transient Claude 429/5xx): Windmill
 * re-invokes this whole script on retry without checking
 * work_items.status first, so a status/label/comment terminal transition
 * here raced with it — see this file's module doc for the full failure
 * sequence. This function now does *nothing* but throw a masked error;
 * every terminal concern (status, labels, notification, and — per
 * impl-m5-poll — an Issue comment) belongs to on_error_flow's
 * failure_module alone, which only runs once Windmill's retries are
 * exhausted.
 */
function failGeneration(reason: string, detail: string): never {
  throw new Error(
    maskSecrets(`pipeline_generate: runClaude failed (${reason}): ${detail}`),
  );
}

export async function main(
  work_item_id: number,
  attempt: number,
  feedback: string | null | undefined,
  worktree_dir: string,
): Promise<PipelineGenerateResult> {
  const log = logger("pipeline_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_generate: no work item with id ${work_item_id}`);
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_generate: work item ${work_item_id} has no issue_number`,
    );
  }

  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    await updateStatus(
      work_item_id,
      "needs_human",
      `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
    );
    await commentIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      `issue-budget-${String(attempt)}`,
      work_item_id,
      "本日の Claude 利用予算の上限に達したため、要件生成を保留しました。人による確認が必要です。",
      viewer.login,
    );
    await removeTerminalLabels(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      config,
    );
    await notifySafe(webhookUrl, {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      url: workItem.issue_url ?? "",
      reason: describeReason("daily budget exceeded"),
      target: { kind: "issue", number: workItem.issue_number },
      next_action: nextActionFor("daily budget exceeded"),
    });
    return { outcome: "budget_exceeded" };
  }

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });
  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-requirements", "drawio-diagram"],
    factoryCloneDir: factoryClone.dir,
  });

  try {
    const previousDraft = attempt > 1 ? await latestDraft(work_item_id) : null;
    const prompt = requirementsPrompt({
      issue: {
        owner: workItem.owner,
        repo: workItem.repo,
        number: workItem.issue_number,
        title: workItem.title ?? "",
        body: workItem.body ?? "",
        url: workItem.issue_url ?? "",
      },
      feedback: resolveFeedback(feedback),
      previousDraft,
      attempt,
    });

    const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");

    const result = await runClaude<RequirementsOutput>({
      run: runCommand,
      workItemId: work_item_id,
      stage: "generate_requirements",
      attempt,
      model: config.model,
      prompt,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: REQUIREMENTS_SCHEMA,
      isStructuredOutput: isRequirementsOutput,
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

    if (result.outcome === "failure") {
      failGeneration(result.reason, result.detail);
    }

    const diagrams = filterValidDiagrams(
      result.structuredOutput.diagrams,
      (diagram, reason) => {
        log.warn("dropping invalid diagram from draft", {
          work_item_id,
          diagram: diagram.name,
          reason,
        });
      },
    );

    await saveDraft({
      work_item_id,
      attempt,
      summary: result.structuredOutput.summary,
      markdown: result.structuredOutput.markdown,
      diagrams,
      open_questions: result.structuredOutput.open_questions,
    });

    return { outcome: "success" };
  } finally {
    await systemPrompt.cleanup();
  }
}
