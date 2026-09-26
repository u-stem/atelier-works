// PathScript for the post-suspend branch of f/factory/pipeline
// (spec-cycle2.md §3 M6 "branch on resume" / this implementer's task brief
// "pipeline_decide.ts"). See pipeline_request_approval.ts's module doc for
// why this step reads the decision from factory.approvals (written by
// f/factory/approval_decide.ts) instead of from the suspend step's own
// results — Windmill CE never actually populates that with the posted
// resume/cancel payload (empirically verified; see that doc comment and
// this implementer's final report for the full writeup).
//
// Every branch re-reads the work item's current status first and no-ops on
// "cancelled" or anything other than "awaiting_approval" (spec-cycle2.md §7
// item 6: a concurrent poll_issues reconcile may have cancelled this work
// item while the flow was suspended). Both the wip label and the trigger
// label are removed on every *terminal* transition (approved / needs_human
// / expired — team-lead rule, M5-review-derived: only a human re-applying
// the trigger label should start a fresh cycle, so a closed-out issue is
// never silently reclaimed forever) but kept on a "reject, retry"
// transition since the work item's lifecycle continues. The requirements
// worktree is always removed at the end, regardless of which branch ran,
// per this implementer's task brief ("Finally remove the req worktree").
//
// [medium, M6 review round 2, devil-advocate, item 13] Every branch that
// reaches a truly terminal status (approved / expired / needs_human — not
// "reject, retry", whose work item lifecycle continues) also clears
// `resume_url`/`cancel_url` via `clearResumeUrls`, right after the CAS
// that makes the transition succeed. Without this, the signed capability
// URL from this work item's most recently consumed suspend keeps sitting
// in the row indefinitely — a defense-in-depth cleanup, since
// pipeline_prepare.ts's cancelled path (reached on a *later* attempt, after
// an earlier attempt's request_approval already set one) does the same.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  clearResumeUrls,
  getWorkItem,
  latestApproval,
  latestDraft,
  setFlowJobId,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { renderIssueSection } from "../lib/drawio.ts";
import {
  commentIssue,
  type GhClient,
  getIssue,
  getViewer,
  removeLabel,
  setLabels,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import type { FactoryConfig, WorkItem } from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { describeReason } from "./pr_workflow_support.ts";

export type PipelineDecideOutcome =
  | "approved"
  | "retrying"
  | "needs_human"
  | "expired"
  | "no_op";

export type PipelineDecideResult = {
  readonly outcome: PipelineDecideOutcome;
};

// Must match pipeline__flow/flow.yaml's suspend.timeout (7 days) — kept as
// a single named constant per the security fix's instruction ("定数を共
// 有"); YAML and TS can't literally share a value, so this comment is the
// tie between them. Used by classifyMissingApproval below.
export const SUSPEND_TIMEOUT_SEC = 604800;

export type MissingApprovalOutcome = "expired" | "needs_human";

/**
 * [high, M6 review round 1b, security-auditor] When `latestApproval` finds
 * no row for this attempt, classify why (pure, for testing):
 * `elapsed >= timeoutSec` means the suspend's own timeout fired naturally
 * (a genuine expiry, per pipeline_request_approval.ts's
 * `continue_on_disapprove_timeout: true`). `elapsed < timeoutSec` means the
 * flow resumed *before* that could have happened without going through
 * approval_decide.ts — the only thing that records a factory.approvals row
 * — i.e. something used the raw `resume_url`/`cancel_url` directly. Since
 * pipeline_request_approval.ts no longer posts those anywhere (see its
 * module doc), an early wake like this means a leaked/reused URL, not
 * normal operation — routed to `needs_human` instead of `expired` so it
 * gets investigated rather than silently absorbed into the ordinary
 * timeout path.
 */
export function classifyMissingApproval(
  now: Date,
  awaitingSince: Date,
  timeoutSec: number,
): MissingApprovalOutcome {
  const elapsedSec = (now.getTime() - awaitingSince.getTime()) / 1000;
  return elapsedSec >= timeoutSec ? "expired" : "needs_human";
}

/** Whether pipeline_decide.ts should proceed at all: the work item must
 * still be exactly `awaiting_approval` (pure, for testing). */
export function shouldProceed(status: WorkItem["status"]): boolean {
  return status === "awaiting_approval";
}

/** Builds the "## 図" + requirements markdown body for the approved-comment
 * (pure, for testing). `draft` is null only if pipeline_generate.ts somehow
 * never saved one — defensive, should not happen on the approve path. */
export function buildApprovedComment(
  draft: {
    readonly markdown: string;
    readonly diagrams: readonly {
      readonly name: string;
      readonly drawio_xml: string;
    }[];
  } | null,
): string {
  if (draft === null) {
    return "要件定義が承認されました。";
  }
  const diagramsSection = renderIssueSection(draft.diagrams);
  const sections = [draft.markdown, diagramsSection].filter(
    (section) => section.length > 0,
  );
  return sections.join("\n\n");
}

/** Terminal transition: remove both wip and trigger labels (team-lead rule,
 * M5-review-derived) so a re-applied trigger label is what starts a fresh
 * cycle, rather than a needs_human/expired issue being silently reclaimed
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
 * The full label set to PUT on an approved issue (pure, for testing):
 * `currentLabels` with `wip_label`/`trigger_label` dropped and
 * `approved_label` added (if not already present) — a swap, not the
 * destructive full-replace a bare `setLabels(..., [approved_label])` would
 * be (that would also drop every label a human had added, e.g. `priority`).
 */
export function computeApprovedLabels(
  currentLabels: readonly string[],
  config: Pick<FactoryConfig, "wip_label" | "trigger_label" | "approved_label">,
): string[] {
  const kept = currentLabels.filter(
    (label) => label !== config.wip_label && label !== config.trigger_label,
  );
  return kept.includes(config.approved_label)
    ? kept
    : [...kept, config.approved_label];
}

async function removeReqWorktree(workItem: WorkItem): Promise<void> {
  if (workItem.issue_number === null) return;
  const repoDir = `/workspaces/${workItem.owner}/${workItem.repo}/main`;
  const worktreeDir = `/workspaces/${workItem.owner}/${workItem.repo}/req-${workItem.issue_number}`;
  try {
    await removeWorktree({
      run: runCommand,
      repoDir,
      dir: worktreeDir,
      force: true,
    });
  } catch (err) {
    logger("pipeline_decide").warn("failed to remove requirements worktree", {
      worktreeDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

async function notifySafe(
  webhookUrl: string,
  event: Parameters<typeof notify>[1],
): Promise<void> {
  if (webhookUrl.length === 0) return;
  await notify(webhookUrl, event);
}

export async function main(
  work_item_id: number,
  attempt: number,
): Promise<PipelineDecideResult> {
  const log = logger("pipeline_decide");
  const config: FactoryConfig = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_decide: no work item with id ${work_item_id}`);
  }
  if (!shouldProceed(workItem.status)) {
    log.info("work item is not awaiting_approval, no-op", {
      work_item_id,
      status: workItem.status,
    });
    return { outcome: "no_op" };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_decide: work item ${work_item_id} has no issue_number`,
    );
  }

  const viewer = await getViewer(client);
  const approval = await latestApproval(work_item_id, attempt);

  if (approval === null) {
    const missingOutcome = classifyMissingApproval(
      new Date(),
      workItem.updated_at,
      SUSPEND_TIMEOUT_SEC,
    );
    const note =
      missingOutcome === "expired"
        ? "approval timed out"
        : "resumed via unsupported channel";
    const updated = await updateStatusIfCurrent(
      work_item_id,
      "awaiting_approval",
      missingOutcome,
      note,
    );
    if (!updated) {
      log.info(
        "work item moved on before the missing-approval outcome could be recorded",
        { work_item_id },
      );
      return { outcome: "no_op" };
    }
    await clearResumeUrls(work_item_id);
    await removeTerminalLabels(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      config,
    );
    const commentBody =
      missingOutcome === "expired"
        ? "承認の期限(7 日間)が切れました。人による対応が必要です。`retry_work_item` から再実行できます。"
        : "承認フローが想定外の経路で再開されました(承認用 URL が直接利用された可能性があります)。人による確認が必要です。";
    await commentIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      `issue-${missingOutcome === "expired" ? "expired" : "needs-human"}-${String(attempt)}`,
      work_item_id,
      commentBody,
      viewer.login,
    );
    await notifySafe(webhookUrl, {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      url: workItem.issue_url ?? "",
      reason: describeReason(note),
    });
    await removeReqWorktree(workItem);
    return { outcome: missingOutcome };
  }

  if (approval.decision === "approved") {
    // [major, M6 review round 2, devil-advocate] The CAS now runs *before*
    // the GitHub side effects (comment, labels), not after. Previously a
    // failed commentIssue call (a GitHub API error) would throw with the
    // suspend already consumed and the work item left `awaiting_approval`
    // forever — the human's approval effectively lost, since nothing would
    // ever re-drive this branch. commentIssue is marker-idempotent and
    // setLabels/notify are safe to repeat, so doing them after a
    // successful CAS means a retry of this step can safely redo them; and
    // if the CAS doesn't apply (the work item already moved on — e.g. a
    // concurrent cancel), this now no-ops immediately instead of posting a
    // stale "approved" comment, matching every other branch in this
    // function.
    const updated = await updateStatusIfCurrent(
      work_item_id,
      "awaiting_approval",
      "approved",
      null,
    );
    if (!updated) {
      log.info("work item moved on before approval could be finalized", {
        work_item_id,
      });
      return { outcome: "no_op" };
    }
    await clearResumeUrls(work_item_id);
    const draft = await latestDraft(work_item_id);
    await commentIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      `issue-approved-${String(attempt)}`,
      work_item_id,
      buildApprovedComment(draft),
      viewer.login,
    );
    const currentIssue = await getIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
    );
    await setLabels(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      computeApprovedLabels(currentIssue.labels, config),
    );
    await notifySafe(webhookUrl, {
      kind: "requirements_approved",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      issue_number: workItem.issue_number,
      issue_url: workItem.issue_url ?? "",
      title: workItem.title ?? "",
    });
    await removeReqWorktree(workItem);
    return { outcome: "approved" };
  }

  // rejected
  if (attempt < config.max_attempts) {
    const updated = await updateStatusIfCurrent(
      work_item_id,
      "awaiting_approval",
      "requirements_generating",
      approval.reason,
    );
    if (!updated) {
      log.info("work item moved on before retry could be started", {
        work_item_id,
      });
      return { outcome: "no_op" };
    }
    // [major, M6 review round 2, devil-advocate] runFlowAsync now runs
    // last, after every other local DB/GitHub side effect (here, just the
    // worktree cleanup) — starting the next attempt's flow launches a
    // concurrent run that will itself re-read work_items almost
    // immediately (its own prepare step), so nothing here should still be
    // in flight once it starts. setFlowJobId necessarily stays right after
    // runFlowAsync, since it records the id that call returns.
    await removeReqWorktree(workItem);
    const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id,
      attempt: attempt + 1,
      feedback: approval.reason ?? "",
    });
    await setFlowJobId(work_item_id, flowJobId);
    return { outcome: "retrying" };
  }

  const updated = await updateStatusIfCurrent(
    work_item_id,
    "awaiting_approval",
    "needs_human",
    approval.reason,
  );
  if (!updated) {
    log.info("work item moved on before needs_human could be recorded", {
      work_item_id,
    });
    return { outcome: "no_op" };
  }
  await clearResumeUrls(work_item_id);
  await removeTerminalLabels(
    client,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
    config,
  );
  await commentIssue(
    client,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
    `issue-needs-human-${String(attempt)}`,
    work_item_id,
    `要件定義が ${String(config.max_attempts)} 回連続で差し戻されました。人による対応が必要です。`,
    viewer.login,
  );
  await notifySafe(webhookUrl, {
    kind: "needs_human",
    instance_name: config.instance_name,
    owner: workItem.owner,
    repo: workItem.repo,
    url: workItem.issue_url ?? "",
    reason: describeReason(`rejected ${String(config.max_attempts)} times`),
  });
  await removeReqWorktree(workItem);
  return { outcome: "needs_human" };
}
