// Handler script for a decided `kind = "requirements"` factory.
// approval_requests row — dispatched by f/factory/approval_decide.ts via
// `wmill.runScriptByPathAsync` right after it records the human's decision.
// Replaces the former pipeline.flow suspend step's post-suspend branch
// (f/factory/steps/pipeline_decide.ts, now deleted): the flow itself no
// longer waits on anything — `pipeline_request_approval.ts` records the
// approval_requests row and returns immediately, and this script runs later
// as an independent job once (and if) a human decides.
//
// Every branch re-reads the work item's current status first and no-ops on
// anything other than "awaiting_approval" (a concurrent poll_issues
// reconcile — or a retried dispatch of this very script — may have already
// moved the work item on). No Issue labeling happens here at all (2026-09-27
// policy: the Issue's `factory` trigger label was already consumed at claim
// time, so there is nothing left to add/remove on any transition — status
// lives solely in work_items.status; re-labeling the Issue is how a human
// starts a brand-new cycle). The requirements worktree is always removed at
// the end, regardless of which branch ran. After an approval, and only while
// `implement_enabled` is on, it then starts the implement flow (工程3;
// lib/implement_launch_support.ts's startImplement).
//
// The CAS (`updateStatusIfCurrent`) runs *before* any GitHub side effect
// (the approved comment) in every branch — a failed GitHub call must never
// leave the work item stuck `awaiting_approval` forever with the decision
// effectively lost, since nothing else re-drives this branch. `commentIssue`
// is marker-idempotent and notify is safe to repeat, so a retried dispatch
// of this script (e.g. approval_decide.ts's `redispatch` path) can safely
// redo it.
//
// Failure handling: this script runs standalone (not as a flow step), so
// there is no flow-level on_error_flow handler to fall back on — a thrown
// error is caught here, recorded to factory.job_failures, and reported to
// Discord before being re-thrown (mirrors on_error_schedule.ts's own
// self-contained handling).

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getApprovalRequest,
  getWorkItem,
  recordFailure,
  setFlowJobId,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { commentIssue, type GhClient, getViewer } from "../lib/github.ts";
import { startImplement } from "../lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "../lib/implement_loop.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { type FactoryConfig, isNumber, type WorkItem } from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

export type RequirementsApplyOutcome =
  | "approved"
  | "retrying"
  | "needs_human"
  | "no_op";

export type RequirementsApplyResult = {
  readonly outcome: RequirementsApplyOutcome;
  /** Set on the approve branch: whether the implement flow was launched. */
  readonly implement_started?: boolean;
};

/** Whether requirements_apply.ts should proceed at all: the work item must
 * still be exactly `awaiting_approval` (pure, for testing). */
export function shouldProceed(status: WorkItem["status"]): boolean {
  return status === "awaiting_approval";
}

/** Builds the one-line "approved" Issue comment (pure, for testing). The
 * draft body is never posted to GitHub (2026-09-27 policy: GitHub carries
 * only work product); the Issue gets a single pointer to the Console. The
 * `work_item_id` is written out alongside the URL as a manual fallback for
 * when the Console can't read its own deep-link fragment (opaque-origin raw
 * app — see lib/approval_support.ts's `buildConsoleUrl` doc comment): a
 * human can still paste it into the 要件定義 tab's work_item_id filter. */
export function buildApprovedComment(
  consoleUrl: string,
  workItemId: number,
): string {
  return `要件定義が承認されました。Console で内容を確認できます: ${consoleUrl}(work_item_id: ${String(workItemId)})`;
}

export type RejectedOutcome = "retry" | "needs_human";

/** Whether a rejected requirements draft should retry (another
 * requirements-generation attempt) or give up to `needs_human` (pure, for
 * testing) — `attempt` is the attempt that was just rejected. */
export function decideRejectedOutcome(
  attempt: number,
  maxAttempts: number,
): RejectedOutcome {
  return attempt < maxAttempts ? "retry" : "needs_human";
}

/** Reads `payload.attempt` (a requester-side approval_requests field) with a
 * type guard, falling back to `fallback` when absent or not a number (pure,
 * for testing) — defensive: every "requirements" request is written by
 * pipeline_request_approval.ts with a numeric `attempt`, but this script
 * must not trust an external DB value's shape without checking. */
export function readRequestAttempt(
  payload: Record<string, unknown>,
  fallback: number,
): number {
  return isNumber(payload.attempt) ? payload.attempt : fallback;
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
    logger("requirements_apply").warn(
      "failed to remove requirements worktree",
      {
        worktreeDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      },
    );
  }
}

async function notifySafe(
  webhookUrl: string,
  event: Parameters<typeof notify>[1],
): Promise<void> {
  if (webhookUrl.length === 0) return;
  await notify(webhookUrl, event);
}

async function run(
  approval_request_id: number,
  log: Logger,
): Promise<RequirementsApplyResult> {
  const config: FactoryConfig = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `requirements_apply: no approval request with id ${approval_request_id}`,
    );
  }
  if (request.kind !== "requirements") {
    throw new Error(
      `requirements_apply: approval request ${approval_request_id} has kind "${request.kind}", expected "requirements"`,
    );
  }

  const workItem = await getWorkItem(request.work_item_id);
  if (workItem === null) {
    throw new Error(
      `requirements_apply: no work item with id ${request.work_item_id}`,
    );
  }
  if (!shouldProceed(workItem.status)) {
    log.info("work item is not awaiting_approval, no-op", {
      work_item_id: workItem.id,
      status: workItem.status,
    });
    return { outcome: "no_op" };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `requirements_apply: work item ${workItem.id} has no issue_number`,
    );
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    // Defensive: approval_decide.ts only ever dispatches here right after
    // recording "approved"/"rejected". An "expired" (or still "pending")
    // request reaching this script means something raced with the expiry
    // sweep (poll_issues.ts) — that sweep owns the expired transition, so
    // this is a no-op here rather than a duplicate/competing one.
    log.info("approval request is not decided, no-op", {
      approval_request_id,
      status: request.status,
    });
    return { outcome: "no_op" };
  }

  const viewer = await getViewer(client);
  const attempt = readRequestAttempt(request.payload, workItem.attempt);

  if (request.status === "approved") {
    const updated = await updateStatusIfCurrent(
      workItem.id,
      "awaiting_approval",
      "approved",
      null,
    );
    if (!updated) {
      log.info("work item moved on before approval could be finalized", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    const consoleUrl = buildConsoleUrl(config.windmill_public_url, {
      work_item_id: workItem.id,
    });
    await commentIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      `issue-approved-${String(attempt)}`,
      workItem.id,
      buildApprovedComment(consoleUrl, workItem.id),
      viewer.login,
    );
    await notifySafe(webhookUrl, {
      kind: "requirements_approved",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      issue_number: workItem.issue_number,
      issue_url: workItem.issue_url ?? "",
      title: workItem.title ?? "",
      console_url: consoleUrl,
    });
    await removeReqWorktree(workItem);
    if (!config.implement_enabled)
      return { outcome: "approved", implement_started: false };
    const issueNumber = workItem.issue_number;
    const launched = await startImplement({
      casToImplementing: () =>
        updateStatusIfCurrent(workItem.id, "approved", "implementing", null),
      launchFlow: () =>
        wmill.runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id: workItem.id }),
      recordFlowJobId: (jobId) => setFlowJobId(workItem.id, jobId),
      moveToNeedsHuman: async (reason) => {
        await updateStatusIfCurrent(
          workItem.id,
          "implementing",
          "needs_human",
          reason,
        );
      },
      recordFailure: async (reason, step) => {
        await recordFailure({
          work_item_id: workItem.id,
          flow_path: IMPLEMENT_FLOW_PATH,
          job_id: process.env.WM_JOB_ID ?? "unknown",
          step,
          error: reason,
        });
      },
      addNotice: async (reason) => {
        await addNotice({
          kind: "implement_launch_failed",
          message: `${workItem.owner}/${workItem.repo}#${String(issueNumber)} (work item ${String(workItem.id)}): ${describeReason(reason)}`,
        });
      },
      notifyNeedsHuman: (reason) =>
        notifySafe(webhookUrl, {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner: workItem.owner,
          repo: workItem.repo,
          url: workItem.issue_url ?? "",
          reason: describeReason(reason),
          target: { kind: "issue", number: issueNumber },
          next_action: nextActionFor(reason),
        }),
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
    return {
      outcome: "approved",
      implement_started:
        launched === "started" || launched === "started_without_job_id",
    };
  }

  // rejected
  const rejectedOutcome = decideRejectedOutcome(attempt, config.max_attempts);
  if (rejectedOutcome === "retry") {
    const updated = await updateStatusIfCurrent(
      workItem.id,
      "awaiting_approval",
      "requirements_generating",
      request.reason,
    );
    if (!updated) {
      log.info("work item moved on before retry could be started", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    // runFlowAsync runs last, after every other local DB/GitHub side effect
    // (here, just the worktree cleanup) — starting the next attempt's flow
    // launches a concurrent run that will itself re-read work_items almost
    // immediately (its own prepare step), so nothing here should still be
    // in flight once it starts. setFlowJobId necessarily stays right after
    // runFlowAsync, since it records the id that call returns.
    await removeReqWorktree(workItem);
    const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id: workItem.id,
      attempt: attempt + 1,
      feedback: request.reason ?? "",
    });
    await setFlowJobId(workItem.id, flowJobId);
    return { outcome: "retrying" };
  }

  const updated = await updateStatusIfCurrent(
    workItem.id,
    "awaiting_approval",
    "needs_human",
    request.reason,
  );
  if (!updated) {
    log.info("work item moved on before needs_human could be recorded", {
      work_item_id: workItem.id,
    });
    return { outcome: "no_op" };
  }
  await notifySafe(webhookUrl, {
    kind: "needs_human",
    instance_name: config.instance_name,
    owner: workItem.owner,
    repo: workItem.repo,
    url: workItem.issue_url ?? "",
    reason: describeReason(`rejected ${String(config.max_attempts)} times`),
    target: { kind: "issue", number: workItem.issue_number },
    next_action: nextActionFor(`rejected ${String(config.max_attempts)} times`),
  });
  await removeReqWorktree(workItem);
  return { outcome: "needs_human" };
}

export async function main(
  approval_request_id: number,
): Promise<RequirementsApplyResult> {
  const log = logger("requirements_apply");
  try {
    return await run(approval_request_id, log);
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("requirements_apply failed", { error: message });
    try {
      await recordFailure({
        work_item_id: null,
        flow_path: "f/factory/steps/requirements_apply",
        job_id: process.env.WM_JOB_ID ?? "unknown",
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
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        await notify(webhookUrl, {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/steps/requirements_apply",
          job_id: process.env.WM_JOB_ID ?? "unknown",
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
    throw err;
  }
}
