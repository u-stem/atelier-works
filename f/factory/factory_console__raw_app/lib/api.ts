// Thin wrappers around the generated `./wmill` bindings for this App's three
// backend runnables (all `type: script` references — see
// ../backend/*.yaml — so there is no inline SQL or business logic here).

import { backend } from "../wmill";
import type { ConsoleView } from "./types";

/** Calls f/factory/steps/console_query.ts. Returns `unknown` — the caller
 * converts each element via lib/types.ts's `to*Row` helpers, which coerce
 * defensively rather than throwing (see lib/coerce.ts's module doc).
 * `work_item_id`/`attempt` are only meaningful for the "requirements_doc"
 * view (ignored server-side otherwise). */
export async function queryConsole(
  view: ConsoleView,
  limit?: number,
  days?: number,
  work_item_id?: number,
  attempt?: number,
): Promise<unknown> {
  return await backend.console_query({
    view,
    limit,
    days,
    work_item_id,
    attempt,
  });
}

export type ApprovalAction = "approve" | "reject";

/** Calls f/factory/approval_decide.ts, the single decision recorder for
 * every approval_requests kind. `reason` is required by that script when
 * `action` is "reject" (empty string is rejected there); `note` is always
 * optional free-text context; `options` carries kind-specific decider-side
 * data (e.g. `{ with_factory_label: boolean }` for an "issue_proposal"
 * request) and defaults to `{}` when omitted. */
export async function decideApproval(
  approvalRequestId: number,
  action: ApprovalAction,
  reason: string,
  note: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return await backend.approval_decide({
    approval_request_id: approvalRequestId,
    decision: action,
    reason,
    note,
    options,
  });
}

/** Calls f/factory/retry_work_item.ts. */
export async function retryWorkItem(workItemId: number): Promise<unknown> {
  return await backend.retry_work_item({ work_item_id: workItemId });
}

/** Renders any thrown value as a short Japanese-friendly message for
 * display — Windmill job errors are usually `Error` instances whose
 * `message` already carries the backend script's own (Japanese-safe) text,
 * but a non-Error rejection (e.g. a raw string) is handled too. */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "不明なエラーが発生しました";
}
