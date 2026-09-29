// Manual retry of a stuck work item. Restartable from failed / needs_human /
// expired / blocked / approved. The restart flow and target status depend
// on the work item's kind: issue → implement when its latest requirements
// approval matches its attempt and implement_enabled is on, else pipeline
// (refused, from any status, when the approval matches but implement_enabled
// is off; an approved issue that cannot go to implement is refused); pr_review →
// pr_review; pr_fix → pr_fix. The status move is a CAS from the status read
// here, so a concurrent change aborts the restart instead of being
// overwritten.
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
import { loadConfig } from "./lib/config.ts";
import {
  getWorkItem,
  latestRequirementsApproval,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { IMPLEMENT_FLOW_PATH } from "./lib/implement_loop.ts";
import { isRequirementsApprovedForAttempt } from "./lib/implement_support.ts";
import { isOneOf, type WorkItem, type WorkItemStatus } from "./lib/types.ts";

const RESTARTABLE_STATUSES = [
  "failed",
  "needs_human",
  "expired",
  "blocked",
  "approved",
] as const;

export type RestartPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/** implementReady: the latest requirements approval is approved for the
 * work item's current attempt (design §8); implementEnabled:
 * factory_config.implement_enabled. Both computed by main. */
export type RestartContext = {
  readonly implementReady: boolean;
  readonly implementEnabled: boolean;
};

/**
 * Given a restartable work item, decides which status to reset it to and
 * which flow to relaunch it with. Throws when `workItem.status` is not one
 * of failed / needs_human / expired / blocked / approved.
 */
export function computeRestartPlan(
  workItem: Pick<WorkItem, "id" | "status" | "kind" | "attempt">,
  context: RestartContext,
): RestartPlan {
  if (!isOneOf(workItem.status, RESTARTABLE_STATUSES)) {
    throw new Error(
      `retry_work_item: work item ${workItem.id} has status "${workItem.status}", not restartable (must be one of ${RESTARTABLE_STATUSES.join(", ")})`,
    );
  }

  switch (workItem.kind) {
    case "issue":
      if (context.implementReady && context.implementEnabled) {
        return {
          toStatus: "implementing",
          flowPath: IMPLEMENT_FLOW_PATH,
          args: { work_item_id: workItem.id },
        };
      }
      // Approved requirements with the implement flow disabled: the
      // pipeline would regenerate requirements a human already approved, so
      // refuse from any status and say how to proceed.
      if (context.implementReady) {
        throw new Error(
          `retry_work_item: work item ${workItem.id} has approved requirements, but implement_enabled is false; enable it to restart the implement flow`,
        );
      }
      if (workItem.status === "approved") {
        throw new Error(
          `retry_work_item: work item ${workItem.id} is approved but its latest requirements approval does not match attempt ${workItem.attempt}; nothing to restart`,
        );
      }
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
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }

  const implementReady =
    workItem.kind === "issue" &&
    isRequirementsApprovedForAttempt(
      await latestRequirementsApproval(work_item_id),
      workItem.attempt,
    );
  const plan = computeRestartPlan(workItem, {
    implementReady,
    implementEnabled: config.implement_enabled,
  });

  const moved = await updateStatusIfCurrent(
    work_item_id,
    workItem.status,
    plan.toStatus,
    `retry_work_item: restarted from ${workItem.status}`,
  );
  if (!moved) {
    throw new Error(
      `retry_work_item: work item ${work_item_id} is no longer "${workItem.status}"; not restarted`,
    );
  }

  const flowJobId = await wmill.runFlowAsync(plan.flowPath, plan.args);
  await setFlowJobId(work_item_id, flowJobId);

  return { ok: true, status: plan.toStatus, flow_job_id: flowJobId };
}
