// Manual retry of a stuck work item (spec-cycle2.md §3 M6
// "retry_work_item.ts"). Restartable from failed / needs_human / expired /
// blocked only; the restart flow and target status depend on the work
// item's `kind` (issue -> pipeline, pr_review -> pr_review, pr_fix ->
// pr_fix).
//
// policy change (2026-09-27, PR label cleanup — extends the Issue-side
// policy from the prior PR to PR kinds): no kind restores any label any
// more. Every trigger label (`factory` for an issue, `factory:review` /
// `factory:fix` for a PR) is consumed once, at claim time, and is never
// re-added automatically — status lives solely in work_items.status, and a
// restarted PR work item is rediscovered by poll_prs.ts's listTrackedPrs
// (DB-backed) rather than by a re-applied label. Restarting a work item of
// any kind therefore relaunches its flow directly with no GitHub side
// effect at all; only a human re-labeling the Issue/PR starts a brand-new
// cycle.
import * as wmill from "windmill-client@1.817.0";
import { getWorkItem, setFlowJobId, updateStatus } from "./lib/db.ts";
import { isOneOf, type WorkItem, type WorkItemStatus } from "./lib/types.ts";

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
    case "audit":
      throw new Error(
        `retry_work_item: work item ${workItem.id} is an audit; audits are not restartable (the next weekly audit covers the failed period, or use 今すぐ監査 in the Console)`,
      );
  }
}

export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly flow_job_id: string;
};

export async function main(work_item_id: number): Promise<RetryWorkItemResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }

  const plan = computeRestartPlan(workItem);

  await updateStatus(
    work_item_id,
    plan.toStatus,
    `retry_work_item: restarted from ${workItem.status}`,
  );

  const flowJobId = await wmill.runFlowAsync(plan.flowPath, plan.args);
  await setFlowJobId(work_item_id, flowJobId);

  return { ok: true, status: plan.toStatus, flow_job_id: flowJobId };
}
