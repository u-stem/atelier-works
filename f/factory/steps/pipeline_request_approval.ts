// PathScript for the "request approval" step of f/factory/pipeline. Records
// a pending `factory.approval_requests` row (kind "requirements") for the
// just-generated draft, flips the work item's status to `awaiting_approval`,
// and posts the "承認待ち" Issue comment (summary + open_questions) plus a
// Discord approval_requested notification. Unlike the former suspend-based
// version of this step, the flow does not wait here at all — it returns
// immediately once the approval request is recorded. A human decides later,
// entirely out of band, via f/factory/approval_decide.ts, which dispatches
// to f/factory/steps/requirements_apply.ts once a decision is recorded.
// poll_issues.ts's scheduled expiry sweep marks a still-pending request
// expired once `expires_at` (computeExpiresAt, lib/approval_support.ts) has
// passed.

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl, computeExpiresAt } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  insertApprovalRequest,
  latestDraft,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { logger } from "../lib/log.ts";

export type PipelineRequestApprovalResult = {
  readonly ok: true;
  readonly approval_request_id: number;
};

export async function main(
  work_item_id: number,
  attempt: number,
): Promise<PipelineRequestApprovalResult> {
  const log = logger("pipeline_request_approval");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(
      `pipeline_request_approval: no work item with id ${work_item_id}`,
    );
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_request_approval: work item ${work_item_id} has no issue_number`,
    );
  }

  const draft = await latestDraft(work_item_id);
  if (draft === null || draft.attempt !== attempt) {
    throw new Error(
      `pipeline_request_approval: work item ${work_item_id} has no requirement draft for attempt ${String(attempt)}`,
    );
  }

  const approvalRequestId = await insertApprovalRequest({
    kind: "requirements",
    work_item_id,
    subject_id: draft.id,
    payload: { attempt },
    expires_at: computeExpiresAt(new Date()),
  });

  const updated = await updateStatusIfCurrent(
    work_item_id,
    "requirements_generating",
    "awaiting_approval",
    null,
  );
  if (!updated) {
    log.info("work item moved on before approval could be requested", {
      work_item_id,
    });
    return { ok: true, approval_request_id: approvalRequestId };
  }

  const inboxUrl = buildConsoleUrl(config.windmill_public_url, {
    work_item_id,
  });

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  if (webhookUrl.length > 0) {
    await notify(webhookUrl, {
      kind: "approval_requested",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      issue_number: workItem.issue_number,
      issue_url: workItem.issue_url ?? "",
      title: workItem.title ?? "",
      inbox_url: inboxUrl,
    });
  }

  log.info("requested approval", {
    work_item_id,
    attempt,
    approval_request_id: approvalRequestId,
  });

  return { ok: true, approval_request_id: approvalRequestId };
}
