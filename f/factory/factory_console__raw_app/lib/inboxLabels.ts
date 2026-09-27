// Pure "how should this Inbox row's kind badge read" mapping — kept
// separate from tabs/InboxTab.tsx so it can be unit-tested without mounting
// React.

import type { InboxRow } from "./types";

export function kindLabel(row: InboxRow): string {
  if (row.kind === "requirements") return "要件定義";
  return row.origin === "audit" ? "改善提案" : "Issue化提案";
}
