// on_error_flow: failure_module handler for factory flows (pipeline.flow,
// pr_review.flow, pr_fix.flow — M6) — spec-cycle2.md §3 M5, §7 item 11.
//
// A flow's failure_module receives the `error` object (`error.message`,
// `error.step_id`, `error.name`, `error.stack` per the write-flow skill)
// plus whatever else its own input_transforms wire in from `flow_input`.
// This handler expects `work_item_id` to be wired from
// `flow_input.work_item_id` (spec-cycle2.md §7 item 11: "flow_input.
// work_item_id を参照"); `path`/`job_id` are accepted for job_failures
// context but are optional since not every flow's failure_module needs to
// wire them. The M6 implementer wiring this into a flow's
// `value.failure_module.value.input_transforms` should map these
// parameter names 1:1 (see this implementer's report for the open
// question this leaves for M6).
//
// devil-advocate note (round 2): pipeline_generate's own failure path now
// funnels into on_error_flow rather than handling termination itself
// (avoids interfering with retry_work_item's status/label bookkeeping).
//
// policy change (2026-09-27): GitHub carries only work product — operational
// notices (including a `failed` transition) go to Discord and the Console
// only, never a GitHub comment. This handler therefore does not post
// anything to the Issue/PR when it marks a work item `failed`. Nor does it
// touch any label: every kind's trigger label (`factory` for an issue,
// `factory:review` / `factory:fix` for a PR) is consumed at claim time
// (2026-09-27 PR label cleanup, matching the Issue-side policy from the
// prior PR), so there is nothing left to remove or set here — the DB status
// transition to `failed` plus the Discord `job_failed` notification
// `main()` sends unconditionally are what reach the operator.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { getWorkItem, recordFailure, updateStatusIfCurrent } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import {
  isRecord,
  isString,
  TERMINAL_WORK_ITEM_STATUSES,
  type WorkItem,
} from "./lib/types.ts";

function errorMessage(error: unknown): string {
  if (isRecord(error) && isString(error.message)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStepId(error: unknown): string | null {
  if (isRecord(error) && isString(error.step_id)) return error.step_id;
  return null;
}

/**
 * The `work_item_id` value safe to pass to `recordFailure` (a real FK
 * column on `job_failures`). devil-advocate fatal fix, found via a live
 * `wmill flow run` with a bogus `work_item_id`: passing a requested id
 * straight through when no such row exists violates
 * `job_failures_work_item_id_fkey` and silently drops the whole failure
 * record (the insert throws, caught, only warn-logged). `item` is the
 * result of looking `requestedId` up (`null` if it doesn't exist, or was
 * never provided); this returns that confirmed id, or `null` — the caller
 * folds `requestedId` into the recorded error text instead so it isn't
 * lost.
 */
export function failureWorkItemRef(
  item: Pick<WorkItem, "id"> | null,
  requestedId: number | undefined,
): number | null {
  if (item === null || requestedId === undefined) return null;
  return item.id;
}

/**
 * Whether this on_error_flow invocation is entitled to mark its work item
 * `failed`. `rootJobId` is this invocation's own flow's root job id
 * (`WM_ROOT_FLOW_JOB_ID`); `workItemFlowJobId` is the job id last recorded
 * via `setFlowJobId` on the work_items row. devil-advocate fatal fix: if a
 * reject/regenerate, `retry_work_item`, or reroute already launched a
 * *newer* flow for this work item before the old one's failure_module
 * fires, the two job ids no longer match — marking the item `failed` now
 * would make the newer run's own prepare step see a terminal status and
 * silently skip (dropping the regeneration). A missing signal on either
 * side (never recorded yet, or running outside a flow context) is treated
 * as "nothing to contradict" and allowed through, matching the prior
 * behavior.
 */
export function shouldMarkFailed(
  workItemFlowJobId: string | null,
  rootJobId: string | null,
): boolean {
  if (workItemFlowJobId === null || rootJobId === null) return true;
  return workItemFlowJobId === rootJobId;
}

export async function main(
  error: unknown,
  work_item_id?: number,
  path?: string,
  job_id?: string,
): Promise<void> {
  const log = logger("on_error_flow");
  const message = maskSecrets(errorMessage(error));
  const resolvedPath = path ?? "unknown";
  const rootJobId = process.env.WM_ROOT_FLOW_JOB_ID ?? null;
  const resolvedJobId =
    job_id ?? rootJobId ?? process.env.WM_JOB_ID ?? "unknown";

  log.error("flow failed", {
    work_item_id,
    path,
    job_id: resolvedJobId,
    error: message,
  });

  let item: WorkItem | null = null;
  if (work_item_id !== undefined) {
    try {
      item = await getWorkItem(work_item_id);
    } catch (fetchErr) {
      log.error("failed to fetch work item", {
        work_item_id,
        error: maskSecrets(
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        ),
      });
    }
  }

  const workItemRef = failureWorkItemRef(item, work_item_id);
  const recordedError =
    work_item_id !== undefined && workItemRef === null
      ? `${message} (work_item_id ${work_item_id}: no matching row)`
      : message;

  try {
    await recordFailure({
      work_item_id: workItemRef,
      flow_path: resolvedPath,
      job_id: resolvedJobId,
      step: errorStepId(error),
      error: recordedError,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }

  if (item !== null && !TERMINAL_WORK_ITEM_STATUSES.includes(item.status)) {
    try {
      if (!shouldMarkFailed(item.flow_job_id, rootJobId)) {
        log.warn(
          "on_error_flow: skipping status transition — work item's flow_job_id no longer matches this run (a newer run already replaced it)",
          {
            work_item_id,
            work_item_flow_job_id: item.flow_job_id,
            root_job_id: rootJobId,
          },
        );
      } else {
        // 2026-09-27 PR label cleanup: every kind's trigger label is
        // consumed at claim time, so there is no label to remove or state
        // label to set on this transition any more — the DB status update
        // alone, plus the Discord job_failed notification below, is what
        // reaches the operator.
        await updateStatusIfCurrent(item.id, item.status, "failed", message);
      }
    } catch (statusErr) {
      log.error("failed to mark work item failed", {
        work_item_id,
        error: maskSecrets(
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        ),
      });
    }
  }

  try {
    const config = await loadConfig(() =>
      wmill.getResource("f/factory/factory_config"),
    );
    const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
    if (webhookUrl.length > 0) {
      await notify(webhookUrl, {
        kind: "job_failed",
        instance_name: config.instance_name,
        flow_path: resolvedPath,
        job_id: resolvedJobId,
        error: message,
      });
    }
  } catch (notifyErr) {
    log.error("failed to send discord notification", {
      error: maskSecrets(
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      ),
    });
  }
}
