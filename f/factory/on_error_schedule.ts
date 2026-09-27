// on_error_schedule: on_failure handler for every *.schedule.yaml in
// f/factory/ (poll_issues.schedule.yaml, poll_prs.schedule.yaml today; M7
// adds more) — spec-cycle2.md §3 M5, §7 item 11.
//
// Windmill invokes a schedule's on_failure handler with a fixed set of
// special arguments. Every one is declared optional here, and this handler
// never itself throws on a missing/renamed field: the parameter names below
// (path, is_flow, schedule_path, job_id, error) match Windmill's documented
// on_failure convention, but spec-cycle2.md §7 item 14's "契約スモーク" only
// covers claude/gtr/gh/datatable, not this handler's argument shape — this
// has NOT been empirically verified against a real failure in this worker.
// Verify once a schedule actually fails in the deployed workspace, and
// adjust the parameter list/type guards here if it differs (see this
// implementer's report).

import * as wmill from "windmill-client";
import { loadConfig } from "./lib/config.ts";
import { recordFailure } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { isRecord, isString } from "./lib/types.ts";

function errorMessage(error: unknown): string {
  if (isRecord(error) && isString(error.message)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function main(
  path?: string,
  is_flow?: boolean,
  schedule_path?: string,
  job_id?: string,
  error?: unknown,
): Promise<void> {
  const log = logger("on_error_schedule");
  const message = maskSecrets(errorMessage(error));
  const flowPath = path ?? schedule_path ?? "unknown";
  const resolvedJobId = job_id ?? "unknown";

  log.error("schedule failed", {
    path,
    is_flow,
    schedule_path,
    job_id: resolvedJobId,
    error: message,
  });

  try {
    await recordFailure({
      work_item_id: null,
      flow_path: flowPath,
      job_id: resolvedJobId,
      step: null,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
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
        flow_path: flowPath,
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
