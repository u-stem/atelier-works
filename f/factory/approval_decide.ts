// Manual (Windmill UI, or the Factory Console App) trigger for approve/
// reject on any pending `factory.approval_requests` row — generalizes what
// used to be two separate scripts (the former suspend-era approval_decide.ts
// for "requirements", and the former issue_proposal_decide.ts for
// "issue_proposal") into one kind-agnostic decision recorder.
//
// Records the decision on the approval_requests row (an atomic
// compare-and-swap, `decideApprovalRequestIfPending`), then dispatches to
// the kind's own handler script (`handlerPathFor`, lib/approval_support.ts)
// via `wmill.runScriptByPathAsync` to carry out the actual GitHub/DB side
// effects. There is no suspended flow to resume anymore — pipeline.flow's
// former suspend step is gone; f/factory/steps/pipeline_request_approval.ts
// just records a pending approval_requests row and returns.
//
// [medium, M6 review round 1b, security-auditor, still applies] The
// `approver` argument used to be trusted as the recorded identity — a bare
// caller-supplied string anyone invoking this script could set to anything.
// It is derived from the job's own Windmill run context (`WM_USERNAME`,
// falling back to `WM_EMAIL`; see `deriveApprover`) instead, and the
// `note` argument is demoted to auxiliary free-text context folded into the
// recorded `reason`, never used as identity.
//
// [major, M6 review round 2, devil-advocate, generalized] Two
// concurrent/duplicate calls for the same approval_requests row must not
// both record a decision. `classifyExistingDecision`
// (lib/approval_support.ts) classifies any existing status against the
// newly requested one: a `pending` row records and dispatches, a matching
// existing decision re-dispatches only (idempotent retry — e.g. the handler
// script's own dispatch failed after the decision was recorded), and a
// conflicting existing decision (or an already-expired row) is refused.

import * as wmill from "windmill-client@1.817.0";
import {
  buildRecordedReason,
  classifyExistingDecision,
  handlerPathFor,
} from "./lib/approval_support.ts";
import { deriveApprover } from "./lib/approver.ts";
import {
  decideApprovalRequestIfPending,
  getApprovalRequest,
} from "./lib/db.ts";
import { isOneOf } from "./lib/types.ts";

const DECISIONS = ["approve", "reject"] as const;
type Decision = (typeof DECISIONS)[number];

export type ApprovalDecideInput = {
  readonly decision: Decision;
  readonly reason: string;
};

/** `reason` is required only when rejecting — an approval needs no
 * justification. */
export function assertValidApprovalDecideInput(
  input: ApprovalDecideInput,
): void {
  if (input.decision === "reject" && input.reason.trim().length === 0) {
    throw new Error(
      'approval_decide: "reason" is required when decision is "reject"',
    );
  }
}

export type ApprovalDecideResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly job_id: string;
};

export async function main(
  approval_request_id: number,
  decision: string,
  reason: string,
  note: string,
  options: Record<string, unknown> = {},
): Promise<ApprovalDecideResult> {
  if (!isOneOf(decision, DECISIONS)) {
    throw new Error(
      `approval_decide: "decision" must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
    );
  }
  assertValidApprovalDecideInput({ decision, reason });

  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `approval_decide: no approval request with id ${approval_request_id}`,
    );
  }

  const recordedStatus = decision === "approve" ? "approved" : "rejected";

  function classify(status: string): "record_and_dispatch" | "redispatch" {
    const action = classifyExistingDecision(status, recordedStatus);
    if (action === "refuse") {
      throw new Error(
        `approval_decide: approval request ${approval_request_id} already has a recorded decision (${status}) that differs from this request (${recordedStatus}), or has expired — refusing to overwrite it`,
      );
    }
    return action;
  }

  const initialAction = classify(request.status);

  if (initialAction === "record_and_dispatch") {
    const approver = deriveApprover({
      WM_USERNAME: process.env.WM_USERNAME,
      WM_EMAIL: process.env.WM_EMAIL,
    });
    const recorded = await decideApprovalRequestIfPending(approval_request_id, {
      status: recordedStatus,
      decided_by: approver,
      reason: buildRecordedReason(reason, note),
      decision_options: options,
    });
    if (!recorded) {
      // Lost a race between the read above and this write — re-read and
      // re-classify against the row's now-current status.
      const current = await getApprovalRequest(approval_request_id);
      if (current === null) {
        throw new Error(
          `approval_decide: approval request ${approval_request_id} disappeared mid-decision`,
        );
      }
      classify(current.status);
    }
  }

  const jobId = await wmill.runScriptByPathAsync(handlerPathFor(request.kind), {
    approval_request_id,
  });

  return { ok: true, status: recordedStatus, job_id: jobId };
}
