// PathScript for the suspend step of f/factory/pipeline (spec-cycle2.md §3
// M6 "request_approval"). Calls wmill.getResumeUrls(), persists resume_url
// / cancel_url on the work item, flips status to awaiting_approval, and
// sends a Discord approval_requested notification. GitHub itself gets no
// comment at this stage (2026-09-27 policy: GitHub carries only work
// product; operational notices — including "awaiting approval" — go to
// Discord/Console only. The Issue does get one comment later, on approval —
// see pipeline_decide.ts's buildApprovedComment).
//
// IMPORTANT — read before changing this step or pipeline_decide.ts (full
// writeup in this implementer's final report): the flow module's downstream
// step never actually receives whatever JSON body a human posts to
// resume_url/cancel_url. Empirically verified against this repo's own
// Windmill server (self-hosted CE 1.817.0), with and without a
// `resume_form` schema on the suspend config: `results.<this step's id>` in
// the next module is always this script's own return value (the
// `{resume, cancel, approvalPage}` object from `wmill.getResumeUrls()`),
// unchanged by any resume/cancel POST body — confirmed across a plain
// resume, a resume posted before the timeout with a decision body, and a
// natural timeout. The rich "resume payload becomes the step's result"
// behavior the OpenAPI spec's `/jobs_u/flow/resume_suspended/{job_id}`
// endpoint (`payload`/`approved` fields) suggests is a different, EE-only
// code path (`/api/.../flows/update`-adjacent audit log entries during this
// probe were tagged `resource: "EE only"`), not what `getResumeUrls()`'s
// plain resume/cancel URLs exercise on CE.
//
// So the actual approve/reject decision + reason/approver cannot be read
// back from the suspend payload at all here. pipeline_decide.ts instead
// reads the decision from factory.approvals, which f/factory/
// approval_decide.ts now records *before* POSTing to resume_url — a small,
// necessary fix to that already-implemented script (see the final report;
// it previously assumed the payload would propagate and recorded nothing).
// continue_on_disapprove_timeout: true (set on this step's suspend config in
// pipeline__flow/flow.yaml) makes a genuine 7-day timeout *also* continue to
// pipeline_decide.ts rather than failing the flow — pipeline_decide.ts tells
// "human decided" from "nobody decided" by whether a factory.approvals row
// exists for (work_item_id, attempt), not from this step's result.
//
// [high, M6 review round 1b, security-auditor] `wmill.getResumeUrls()`'s
// `approvalPage` is a signed capability URL: anyone who sees it can
// resume/cancel this suspended flow directly, with no login and without
// going through approval_decide.ts — so no factory.approvals row gets
// recorded, and pipeline_decide.ts previously had no way to tell that
// apart from a genuine 7-day timeout. `approvalPage` must never be posted
// anywhere (Discord, the Issue comment, or this step's own return value —
// Windmill persists every job's args/result indefinitely, which is itself
// a broad-enough audience to treat as "public" for a bearer credential).
// Only `resume_url`/`cancel_url` are persisted (to the DB, not posted
// anywhere), and only for approval_decide.ts's own use. Everywhere a human
// needs a link, it is the App's own authenticated Inbox URL instead — see
// `buildInboxUrl`. pipeline_decide.ts's `classifyMissingApproval` is the
// other half of this fix: it now treats an early wake with no approvals
// row as `needs_human` ("resumed via unsupported channel") rather than
// blindly calling it `expired`.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, setResumeUrls, updateStatus } from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { logger } from "../lib/log.ts";

// Kept as a single named constant per the security fix's instruction
// ("定数化して1箇所に") — the exact Windmill App view URL path, so a future
// correction (once f/factory/factory_console is actually created and its
// real URL can be verified) is a one-line change.
const FACTORY_CONSOLE_APP_PATH = "f/factory/factory_console";

/** The App's authenticated Inbox URL (pure, for testing) — the only link
 * ever posted for "go approve/reject this", replacing the raw
 * `getResumeUrls()` `approvalPage` capability URL (security fix, see this
 * file's module doc). */
export function buildInboxUrl(windmillPublicUrl: string): string {
  return `${windmillPublicUrl}/apps/get/${FACTORY_CONSOLE_APP_PATH}`;
}

export type PipelineRequestApprovalResult = {
  readonly ok: true;
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

  // `urls.approvalPage` is deliberately never read — see the security-fix
  // module doc above.
  const urls = await wmill.getResumeUrls();
  await setResumeUrls(work_item_id, urls.resume, urls.cancel);
  await updateStatus(work_item_id, "awaiting_approval", null);

  const inboxUrl = buildInboxUrl(config.windmill_public_url);

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

  log.info("requested approval", { work_item_id, attempt });

  return { ok: true };
}
