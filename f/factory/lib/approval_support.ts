// Pure decision logic shared by every script in the generalized
// approval_requests flow (approval_decide.ts, pipeline_request_approval.ts,
// steps/requirements_apply.ts, steps/issue_proposal_apply.ts, poll_issues.ts's
// expiry sweep) — replaces pipeline.flow's suspend-based approval wait
// (spec: "Generalize approval waiting away from suspend"). No I/O here; every
// function is exported for unit testing.

import type { ApprovalRequest, ApprovalRequestKind } from "./types.ts";

/** How long a "requirements" approval request stays pending before the
 * scheduled expiry sweep (poll_issues.ts) marks it expired — matches the
 * former pipeline.flow suspend step's own 7-day timeout. `"issue_proposal"`
 * requests never expire (no deadline; see `insertApprovalRequest`'s
 * `expires_at: null` at that call site). */
export const APPROVAL_TIMEOUT_SEC = 604800;

/** The `expires_at` deadline for a freshly requested "requirements" approval,
 * `APPROVAL_TIMEOUT_SEC` after `now` (pure, for testing). */
export function computeExpiresAt(now: Date): Date {
  return new Date(now.getTime() + APPROVAL_TIMEOUT_SEC * 1000);
}

/** Whether a `factory.approval_requests` row is a still-`pending` request
 * whose deadline has passed (pure, for testing) — the predicate behind
 * poll_issues.ts's expiry sweep. A request with `expires_at: null` (e.g.
 * "issue_proposal") is never expired. */
export function isExpired(
  request: Pick<ApprovalRequest, "status" | "expires_at">,
  now: Date,
): boolean {
  return (
    request.status === "pending" &&
    request.expires_at !== null &&
    request.expires_at.getTime() <= now.getTime()
  );
}

export type ExistingDecisionAction =
  | "record_and_dispatch"
  | "redispatch"
  | "refuse";

/**
 * Classifies what approval_decide.ts's main() should do about an
 * approval_requests row it just read, given the decision this call is being
 * asked to record (pure, for testing — mirrors the former
 * `classifyExistingApproval` / `classifyIssueProposalDecision` shape used by
 * the two suspend-era scripts this one generalizes):
 *   - `"record_and_dispatch"`: the row is still `pending` — record the
 *     decision, then dispatch to the kind's apply script.
 *   - `"redispatch"`: the row already carries the *same* decision as
 *     requested (an idempotent retry, e.g. the apply script's own dispatch
 *     failed after the decision was recorded) — do not record again, but
 *     still dispatch.
 *   - `"refuse"`: the row carries a *different* decision (a genuine
 *     conflict) or has expired — nothing to do, the caller should throw.
 */
export function classifyExistingDecision(
  existingStatus: string,
  requestedStatus: "approved" | "rejected",
): ExistingDecisionAction {
  if (existingStatus === "pending") {
    return "record_and_dispatch";
  }
  return existingStatus === requestedStatus ? "redispatch" : "refuse";
}

/**
 * Folds a caller-supplied `note` into the recorded `reason` (pure, for
 * testing) — moved from the former approval_decide.ts unchanged. `null` when
 * there is nothing to record.
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

// Kept as a single named constant per the original security fix's
// instruction ("定数化して1箇所に") — the exact Windmill App view URL path, so
// a future correction (once the real URL can be verified) is a one-line
// change. Moved here (from the former pipeline_request_approval.ts's
// buildInboxUrl) since every approval-flow script that posts a link to the
// Console now shares it, not just the requirements-approval request step.
const FACTORY_CONSOLE_APP_PATH = "f/factory/factory_console";

/** The Factory Console App's authenticated Inbox URL (pure, for testing) —
 * the only link ever posted for "go approve/reject this" (no raw suspend
 * capability URL exists anymore to leak). When `target.work_item_id` is
 * given, appends a `#requirements/<id>` deep-link fragment so the Console's
 * 要件定義 tab can jump straight to that work item's requirements document
 * (see the raw app's `lib/deepLink.ts`) — the App itself decides whether it
 * can actually read the fragment (opaque-origin raw apps may not be able to
 * see the parent frame's URL), so this is a best-effort convenience, not a
 * guarantee; the work_item_id is also written out alongside this URL by
 * every caller (Issue comment / Discord field) as a manual fallback. */
export function buildConsoleUrl(
  windmillPublicUrl: string,
  target?: { work_item_id: number },
): string {
  const base = `${windmillPublicUrl}/apps/get/${FACTORY_CONSOLE_APP_PATH}`;
  return target === undefined
    ? base
    : `${base}#requirements/${String(target.work_item_id)}`;
}

/** Which step script handles a decided approval_requests row of this kind
 * (pure, for testing) — approval_decide.ts dispatches to this path via
 * `wmill.runScriptByPathAsync` after recording the decision. */
export function handlerPathFor(kind: ApprovalRequestKind): string {
  switch (kind) {
    case "requirements":
      return "f/factory/steps/requirements_apply";
    case "issue_proposal":
      return "f/factory/steps/issue_proposal_apply";
  }
}

/** Narrows a list of approval_requests-shaped rows to the "requirements"
 * kind (pure, for testing) — poll_issues.ts's expiry sweep only needs to
 * apply requirements-specific side effects (status transition, label
 * cleanup) to this subset; "issue_proposal" requests never carry an
 * `expires_at` so they never appear in the expired set to begin with, but
 * this keeps the sweep's per-kind branching testable independently of that
 * DB-side guarantee. */
export function expiredRequirementsRequests<
  T extends { kind: ApprovalRequestKind },
>(requests: readonly T[]): T[] {
  return requests.filter((request) => request.kind === "requirements");
}
