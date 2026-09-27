// Manual retry of a stuck work item (spec-cycle2.md §3 M6
// "retry_work_item.ts"). Restartable from failed / needs_human / expired /
// blocked only; the restart flow and target status depend on the work
// item's `kind` (issue -> pipeline, pr_review -> pr_review, pr_fix ->
// pr_fix).
//
// devil-advocate fatal fix (PR kinds only, see 2026-09-27 policy note
// below): a terminal PR work item has had its wip + trigger label removed
// (pr_* terminal transitions, and poll_issues's reconcile). Relaunching the
// flow without re-adding them first left the GitHub PR still missing the
// trigger label, so poll_issues's reconcile would see it as "trigger label
// removed" within its next 5-minute run and immediately cancel the
// just-restarted flow. Labels are now idempotently re-added before the
// status transition and `runFlowAsync`.
//
// devil-advocate note (round 2): the fix above originally reused
// `claimIssue` for every kind, but that also assigns the factory as
// GitHub assignee — for PR kinds this contradicts `claimPr`'s
// no-assignee decision (an assignee left in place would keep candidating
// the PR forever via `assignee:<viewer>` search, spec-cycle2.md §7 item
// 1's own de-dup notwithstanding, since assignment isn't head_sha-scoped).
// PR kinds (pr_review / pr_fix) use `addLabels` — additive, no assignee.
//
// policy change (2026-09-27): issue kind no longer restores any label —
// the Issue's `factory` trigger label is consumed once, at claim time, and
// is never re-added automatically (status lives solely in
// work_items.status). Restarting an issue work item therefore relaunches
// `f/factory/pipeline` directly with no GitHub side effect at all; only a
// human re-labeling the Issue starts a brand-new cycle. PR-kind label
// restoration is unchanged pending the follow-up PR that does the same
// cleanup for PRs.
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { getWorkItem, setFlowJobId, updateStatus } from "./lib/db.ts";
import { addLabels, type GhClient } from "./lib/github.ts";
import { type Logger, logger } from "./lib/log.ts";
import {
  type FactoryConfig,
  isOneOf,
  type WorkItem,
  type WorkItemStatus,
} from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import {
  allStateLabels,
  removeTerminalLabels,
} from "./steps/pr_workflow_support.ts";

const RESTARTABLE_STATUSES = [
  "failed",
  "needs_human",
  "expired",
  "blocked",
] as const;

export type RestartPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/**
 * Given a restartable work item, decides which status to reset it to and
 * which flow to relaunch it with. Throws when `workItem.status` is not one
 * of failed / needs_human / expired / blocked.
 */
export function computeRestartPlan(
  workItem: Pick<WorkItem, "id" | "status" | "kind" | "attempt">,
): RestartPlan {
  if (!isOneOf(workItem.status, RESTARTABLE_STATUSES)) {
    throw new Error(
      `retry_work_item: work item ${workItem.id} has status "${workItem.status}", not restartable (must be one of ${RESTARTABLE_STATUSES.join(", ")})`,
    );
  }

  switch (workItem.kind) {
    case "issue":
      return {
        toStatus: "requirements_generating",
        flowPath: "f/factory/pipeline",
        args: { work_item_id: workItem.id, attempt: workItem.attempt + 1 },
      };
    case "pr_review":
      return {
        toStatus: "reviewing",
        flowPath: "f/factory/pr_review",
        args: { work_item_id: workItem.id },
      };
    case "pr_fix":
      return {
        toStatus: "fixing",
        flowPath: "f/factory/pr_fix",
        args: { work_item_id: workItem.id },
      };
  }
}

/**
 * The wip label plus the one kind-specific trigger label that a terminal PR
 * work item's `kind` had removed (pr_* terminal transitions, poll_issues's
 * reconcile) — and that must be idempotently re-present before relaunching
 * its flow, or poll_issues's reconcile will read the missing trigger label
 * as "removed" and cancel the restart within its next 5-minute run. Issue
 * kind has no equivalent (2026-09-27 policy — see this file's module doc).
 */
export function labelsToRestore(
  kind: "pr_review" | "pr_fix",
  config: Pick<FactoryConfig, "wip_label" | "review_label" | "fix_label">,
): string[] {
  switch (kind) {
    case "pr_review":
      return [config.wip_label, config.review_label];
    case "pr_fix":
      return [config.wip_label, config.fix_label];
  }
}

async function restorePrLabels(
  client: GhClient,
  workItem: Pick<WorkItem, "owner" | "repo" | "pr_number">,
  kind: "pr_review" | "pr_fix",
  config: FactoryConfig,
  log: Logger,
): Promise<void> {
  const number = workItem.pr_number;
  if (number === null) {
    throw new Error(
      `retry_work_item: work item has kind "${kind}" but no pr_number`,
    );
  }
  const labels = labelsToRestore(kind, config);

  // team-lead design (2026-09-26): the PR is active again, so any state
  // label a previous terminal transition left on it (changes-requested /
  // reviewed / rereview / needs-human) no longer applies — best-effort,
  // like every other terminal-transition label cleanup.
  await removeTerminalLabels(
    client,
    workItem.owner,
    workItem.repo,
    number,
    allStateLabels(config),
    log,
  );
  await addLabels(client, workItem.owner, workItem.repo, number, labels);
}

export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly flow_job_id: string;
};

export async function main(work_item_id: number): Promise<RetryWorkItemResult> {
  const log = logger("retry_work_item");
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }

  const plan = computeRestartPlan(workItem);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  if (workItem.kind !== "issue") {
    await restorePrLabels(client, workItem, workItem.kind, config, log);
  }

  await updateStatus(
    work_item_id,
    plan.toStatus,
    `retry_work_item: restarted from ${workItem.status}`,
  );

  const flowJobId = await wmill.runFlowAsync(plan.flowPath, plan.args);
  await setFlowJobId(work_item_id, flowJobId);

  return { ok: true, status: plan.toStatus, flow_job_id: flowJobId };
}
