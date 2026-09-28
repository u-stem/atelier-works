// Pure "how should this Inbox row's kind badge read" mapping — kept
// separate from tabs/InboxTab.tsx so it can be unit-tested without mounting
// React.

import type { InboxRow } from "./types";

export function kindLabel(row: InboxRow): string {
  if (row.kind === "requirements") return "要件定義";
  return row.origin === "audit" ? "改善提案" : "Issue化提案";
}

/** Default state of the "起票と同時にfactoryラベルを付けて要件定義に進める"
 * checkbox when a row is selected: on for an audit-origin issue_proposal
 * (改善提案 — an audit-sourced Issue is meant to re-enter the requirements
 * pipeline immediately), off otherwise (a pr_fix-origin issue_proposal
 * defaults to filing-only, per the requester's own checkbox). */
export function defaultWithFactoryLabel(row: InboxRow): boolean {
  return row.kind === "issue_proposal" && row.origin === "audit";
}
