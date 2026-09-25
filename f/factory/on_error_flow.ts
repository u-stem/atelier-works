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

import * as wmill from "windmill-client";
import { loadConfig } from "./lib/config.ts";
import { getWorkItem, recordFailure, updateStatusIfCurrent } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import {
  isRecord,
  isString,
  TERMINAL_WORK_ITEM_STATUSES,
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

export async function main(
  error: unknown,
  work_item_id?: number,
  path?: string,
  job_id?: string,
): Promise<void> {
  const log = logger("on_error_flow");
  const message = maskSecrets(errorMessage(error));
  const resolvedPath = path ?? "unknown";
  const resolvedJobId = job_id ?? "unknown";

  log.error("flow failed", {
    work_item_id,
    path,
    job_id: resolvedJobId,
    error: message,
  });

  try {
    await recordFailure({
      work_item_id: work_item_id ?? null,
      flow_path: resolvedPath,
      job_id: resolvedJobId,
      step: errorStepId(error),
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }

  if (work_item_id !== undefined) {
    try {
      const item = await getWorkItem(work_item_id);
      if (item !== null && !TERMINAL_WORK_ITEM_STATUSES.includes(item.status)) {
        await updateStatusIfCurrent(
          work_item_id,
          item.status,
          "failed",
          message,
        );
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
