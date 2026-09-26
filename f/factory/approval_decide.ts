// Manual (Windmill UI, or a future App) trigger for approve/reject on a
// suspended pipeline.flow run: records the decision, then POSTs to the
// work item's `resume_url` to unblock the suspended flow (spec-cycle2.md §3
// M6 "approval_decide.ts").
//
// Fix (M6 pipeline implementer, see that implementer's final report for the
// full writeup): this script now records the factory.approvals row itself,
// *before* resuming. It originally left that to pipeline.flow, on the
// assumption that the JSON body posted to resume_url would surface as the
// suspended step's result in the next flow module — empirically false on
// this repo's self-hosted Windmill CE (1.817.0): the next module always
// sees the suspend step's own pre-suspend return value
// (`wmill.getResumeUrls()`'s `{resume, cancel, approvalPage}`), never the
// posted body, resume_form or not. f/factory/steps/pipeline_decide.ts reads
// the decision back from factory.approvals instead.
//
// [medium, M6 review round 1b, security-auditor] The `approver` argument
// used to be trusted as the recorded identity — a bare caller-supplied
// string anyone invoking this script could set to anything. It is now
// derived from the job's own Windmill run context (`WM_USERNAME`, falling
// back to `WM_EMAIL`; see `deriveApprover`) instead, and the former
// argument is demoted to `note`: optional free-text context folded into
// the recorded `reason`, never used as identity. Also added: a decision is
// refused if the work item's latest requirement draft isn't for its
// current attempt (`workItem.attempt`) — defense in depth against a stale
// decision (e.g. a browser tab left open on an old Inbox entry) being
// recorded against the wrong attempt.
//
// `resume_url` is a secret-bearing URL (anyone holding it can resume the
// suspended job): it is read from the DB and used as the fetch target, but
// never logged, thrown in an error message, or otherwise put in this
// script's return value or job log.
//
// [major, M6 review round 2, devil-advocate] `factory.approvals` has no
// UNIQUE constraint on (work_item_id, attempt), so nothing at the DB layer
// stopped two concurrent/duplicate calls from both recording a decision
// for the same attempt. This script now classifies any existing row for
// this attempt against the newly requested decision — see
// `classifyExistingApproval`.
//
// [medium, security-auditor re-gate] A first cut of the above simply
// refused whenever a row already existed. But if the resume POST below
// fails *after* recordApproval already succeeded (a network blip, a
// worker restart), a retry of this exact same decision would then be
// rejected outright — the decision would sit recorded in
// factory.approvals but never actually resume the suspended flow, stuck
// until the suspend's own 7-day timeout. `classifyExistingApproval` now
// tells an identical-decision retry from a genuine conflict (a different
// decision recorded for this attempt): the former skips recordApproval
// and re-POSTs only (idempotent), the latter is still refused.
//
// [medium, M6 review round 2, devil-advocate] `wmill.getResumeUrls()`
// builds the resume URL from the instance's externally-facing BASE_URL
// (e.g. `127.0.0.1:8080` in this repo's docker compose), which this
// script's own `fetch` — running *inside* a worker container — likely
// cannot reach. `toInternalUrl` rewrites the URL's origin before the POST.
//
// [medium, security-auditor re-gate — measured] The origin to rewrite to
// was first taken from `BASE_INTERNAL_URL` alone. Measured directly from
// inside a real worker job: `BASE_INTERNAL_URL` is unset there;
// `BASE_URL` *is* set, and `${BASE_URL}/api/version` returns HTTP 200 from
// that job — while `http://127.0.0.1:8080` (the origin
// `wmill.getResumeUrls()` actually bakes into the URL) is unreachable, so
// the original `BASE_INTERNAL_URL`-only lookup was a no-op and the resume
// POST failed every time. `resolveInternalBase` now falls back to
// `BASE_URL` when `BASE_INTERNAL_URL` is unset, preferring
// `BASE_INTERNAL_URL` if a future deployment ever sets both.

import { deriveApprover } from "./lib/approver.ts";
import {
  getWorkItem,
  latestApproval,
  latestDraft,
  recordApproval,
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

/**
 * Folds the caller-supplied `note` (formerly the trusted `approver`
 * argument, now just auxiliary context — see the module doc) into the
 * recorded `reason` (pure, for testing). `null` when there is nothing to
 * record.
 */
export function buildRecordedReason(
  reason: string,
  note: string,
): string | null {
  const parts: string[] = [];
  const trimmedReason = reason.trim();
  if (trimmedReason.length > 0) {
    parts.push(trimmedReason);
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length > 0) {
    parts.push(`(caller note: ${trimmedNote})`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Whether `draftAttempt` (the work item's latest requirement draft's
 * attempt, or `null` if it has no draft) matches `workItemAttempt` (pure,
 * for testing) — a mismatch means this decision is stale (e.g. a browser
 * tab left open on an old Inbox entry after a reject-and-retry cycle
 * already moved the work item to a new attempt) and must be refused. */
export function isDecisionForCurrentAttempt(
  draftAttempt: number | null,
  workItemAttempt: number,
): boolean {
  return draftAttempt === workItemAttempt;
}

export type ApprovalDecideAction = "record_and_post" | "repost_only" | "reject";

/**
 * Classifies what main() should do about `factory.approvals`, given any
 * existing row for this attempt (`latestApproval`'s result — a minimal
 * structural type, not the full `Approval` type, keeps this testable with
 * a bare fake) and the decision this call is being asked to record
 * (already mapped to its stored form, `"approved"`/`"rejected"`, so the
 * comparison is apples-to-apples). Pure, for testing — see the module
 * doc's security-auditor re-gate note for why a same-decision retry must
 * be allowed to re-POST without writing a second row.
 */
export function classifyExistingApproval(
  existing: { readonly decision: string } | null,
  recordedDecision: string,
): ApprovalDecideAction {
  if (existing === null) {
    return "record_and_post";
  }
  return existing.decision === recordedDecision ? "repost_only" : "reject";
}

/**
 * Rewrites `url`'s origin (protocol + host) to `internalBase`'s, keeping
 * its path/query/hash (pure, for testing) — see the module doc's second
 * devil-advocate note. Returns `url` unchanged when `internalBase` is
 * unset or empty, so this is a no-op wherever the two already coincide
 * (e.g. a non-containerized dev setup).
 */
export function toInternalUrl(
  url: string,
  internalBase: string | undefined,
): string {
  if (internalBase === undefined || internalBase.length === 0) {
    return url;
  }
  const target = new URL(url);
  const internal = new URL(internalBase);
  target.protocol = internal.protocol;
  target.host = internal.host;
  return target.toString();
}

export type InternalBaseEnv = {
  readonly BASE_INTERNAL_URL?: string | undefined;
  readonly BASE_URL?: string | undefined;
};

/**
 * Picks the origin `toInternalUrl` should rewrite the resume URL to (pure,
 * for testing): `BASE_INTERNAL_URL` if set, else `BASE_URL`, else
 * `undefined` (in which case `toInternalUrl` no-ops) — see the module
 * doc's security-auditor re-gate note for the measured environment this
 * fallback order is based on.
 */
export function resolveInternalBase(env: InternalBaseEnv): string | undefined {
  return env.BASE_INTERNAL_URL ?? env.BASE_URL ?? undefined;
}

export type ApprovalDecideResult = {
  readonly ok: boolean;
  readonly status: string;
};

export async function main(
  work_item_id: number,
  decision: string,
  reason: string,
  note: string,
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

  const draft = await latestDraft(work_item_id);
  if (!isDecisionForCurrentAttempt(draft?.attempt ?? null, workItem.attempt)) {
    throw new Error(
      `approval_decide: work item ${work_item_id}'s latest draft is for attempt ${String(draft?.attempt ?? "none")}, but the work item is on attempt ${String(workItem.attempt)} — refusing to record a stale decision`,
    );
  }

  const recordedDecision = decision === "approve" ? "approved" : "rejected";
  const existingApproval = await latestApproval(work_item_id, workItem.attempt);
  const action = classifyExistingApproval(existingApproval, recordedDecision);
  if (action === "reject") {
    throw new Error(
      `approval_decide: work item ${work_item_id} attempt ${String(workItem.attempt)} already has a recorded decision (${String(existingApproval?.decision)}) that differs from this request (${recordedDecision}) — refusing to overwrite it`,
    );
  }

  const approver = deriveApprover({
    WM_USERNAME: process.env.WM_USERNAME,
    WM_EMAIL: process.env.WM_EMAIL,
  });

  if (action === "record_and_post") {
    await recordApproval({
      work_item_id,
      attempt: workItem.attempt,
      decision: recordedDecision,
      reason: buildRecordedReason(reason, note),
      approver,
    });
  }

  const resumeUrl = toInternalUrl(
    workItem.resume_url,
    resolveInternalBase({
      BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
      BASE_URL: process.env.BASE_URL,
    }),
  );
  const response = await fetch(resumeUrl, {
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
