// Starting the implement flow after a requirements approval (工程3 design
// §1): approved → implementing first (approved is terminal, so on_error_flow
// could not fail a flow that dies before prepare), then runFlowAsync, then
// setFlowJobId. Every side effect has its own try so one failure never
// skips the bookkeeping after it, and nothing is thrown:
//   - CAS false or throwing: someone else (retry_work_item) moved the item;
//     leave it alone — forcing needs_human would clobber a running flow.
//   - runFlowAsync throws: implementing → needs_human, job_failures (the
//     Console Failures tab offers the retry), notice, Discord.
//   - setFlowJobId throws (twice — it is retried once): the flow is
//     running, so the status stays implementing; job_failures + notice
//     only.

import { maskSecrets } from "./log.ts";

export function implementLaunchFailureReason(message: string): string {
  return `implement flow could not be started: ${message}`;
}

export function flowJobIdFailureReason(message: string): string {
  return `implement flow job id could not be recorded: ${message}`;
}

export type StartImplementDeps = {
  /** updateStatusIfCurrent(approved → implementing). */
  readonly casToImplementing: () => Promise<boolean>;
  /** runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id }). */
  readonly launchFlow: () => Promise<string>;
  readonly recordFlowJobId: (jobId: string) => Promise<void>;
  /** updateStatusIfCurrent(implementing → needs_human, reason). */
  readonly moveToNeedsHuman: (reason: string) => Promise<void>;
  /** recordFailure with flow_path IMPLEMENT_FLOW_PATH and this step name. */
  readonly recordFailure: (reason: string, step: string) => Promise<void>;
  readonly addNotice: (reason: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type StartImplementOutcome =
  | "started"
  | "started_without_job_id"
  | "not_moved"
  | "launch_failed";

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

async function attempt(
  deps: StartImplementDeps,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    deps.log(`startImplement: ${label} failed`, { error: messageOf(err) });
  }
}

export async function startImplement(
  deps: StartImplementDeps,
): Promise<StartImplementOutcome> {
  let moved = false;
  try {
    moved = await deps.casToImplementing();
  } catch (err) {
    deps.log("startImplement: approved → implementing failed", {
      error: messageOf(err),
    });
    return "not_moved";
  }
  if (!moved) return "not_moved";

  let jobId: string;
  try {
    jobId = await deps.launchFlow();
  } catch (err) {
    const reason = implementLaunchFailureReason(messageOf(err));
    await attempt(deps, "needs_human transition", () =>
      deps.moveToNeedsHuman(reason),
    );
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "launch"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    await attempt(deps, "Discord notify", () => deps.notifyNeedsHuman(reason));
    return "launch_failed";
  }

  try {
    try {
      await deps.recordFlowJobId(jobId);
    } catch (err) {
      deps.log("startImplement: recordFlowJobId failed; retrying once", {
        error: messageOf(err),
      });
      await deps.recordFlowJobId(jobId);
    }
    return "started";
  } catch (err) {
    const reason = flowJobIdFailureReason(messageOf(err));
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "record_flow_job_id"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    return "started_without_job_id";
  }
}
