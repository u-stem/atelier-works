// Manual (Windmill UI, or a future App) trigger for approve/reject on a
// suspended pipeline.flow run: POSTs the decision to the work item's
// `resume_url` (spec-cycle2.md §3 M6 "approval_decide.ts"). This script
// records nothing itself — the resumed flow (pipeline.flow, owned by the M6
// task) is what records the factory.approvals row once it reads the
// posted decision back out of the resume payload.
//
// `resume_url` is a secret-bearing URL (anyone holding it can resume the
// suspended job): it is read from the DB and used as the fetch target, but
// never logged, thrown in an error message, or otherwise put in this
// script's return value or job log.

import { getWorkItem } from "./lib/db.ts";
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
};

export async function main(
  work_item_id: number,
  decision: string,
  reason: string,
  approver: string,
): Promise<ApprovalDecideResult> {
  if (!isOneOf(decision, DECISIONS)) {
    throw new Error(
      `approval_decide: "decision" must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
    );
  }
  assertValidApprovalDecideInput({ decision, reason });

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`approval_decide: no work item with id ${work_item_id}`);
  }
  if (workItem.status !== "awaiting_approval") {
    throw new Error(
      `approval_decide: work item ${work_item_id} is not awaiting_approval (current status: ${workItem.status})`,
    );
  }
  if (workItem.resume_url === null) {
    throw new Error(
      `approval_decide: work item ${work_item_id} has no resume_url`,
    );
  }

  const response = await fetch(workItem.resume_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, reason, approver }),
  });

  if (response.status < 200 || response.status >= 300) {
    // Deliberately omit workItem.resume_url from the error message.
    throw new Error(
      `approval_decide: resume request for work item ${work_item_id} failed with HTTP ${response.status}`,
    );
  }

  return { ok: true, status: "resumed" };
}
