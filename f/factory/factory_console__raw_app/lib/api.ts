// Thin wrappers around the generated `./wmill` bindings for this App's three
// backend runnables (all `type: script` references — see
// ../backend/*.yaml — so there is no inline SQL or business logic here).

import { backend } from "../wmill";
import type { ConsoleView } from "./types";

/** Calls f/factory/steps/console_query.ts. Returns `unknown` — the caller
 * converts each element via lib/types.ts's `to*Row` helpers, which coerce
 * defensively rather than throwing (see lib/coerce.ts's module doc). */
export async function queryConsole(
  view: ConsoleView,
  limit?: number,
  days?: number,
): Promise<unknown> {
  return await backend.console_query({ view, limit, days });
}

export type ApprovalAction = "approve" | "reject";

/** Calls f/factory/approval_decide.ts. `reason` is required by that script
 * when `action` is "reject" (empty string is rejected there); `note` is
 * always optional free-text context. */
export async function decideApproval(
  workItemId: number,
  action: ApprovalAction,
  reason: string,
  note: string,
): Promise<unknown> {
  return await backend.approval_decide({
    work_item_id: workItemId,
    decision: action,
    reason,
    note,
  });
}

/** Calls f/factory/retry_work_item.ts. */
export async function retryWorkItem(workItemId: number): Promise<unknown> {
  return await backend.retry_work_item({ work_item_id: workItemId });
}

/** Calls f/factory/issue_proposal_decide.ts. `reason` is required by that
 * script when `action` is "reject" (empty string is rejected there);
 * `withFactoryLabel` only matters on "approve" (whether the created Issue
 * gets `factory_config.trigger_label`, entering the requirements
 * pipeline). */
export async function decideIssueProposal(
  proposalId: number,
  action: ApprovalAction,
  reason: string,
  withFactoryLabel: boolean,
): Promise<unknown> {
  return await backend.issue_proposal_decide({
    proposal_id: proposalId,
    decision: action,
    reason,
    with_factory_label: withFactoryLabel,
  });
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
