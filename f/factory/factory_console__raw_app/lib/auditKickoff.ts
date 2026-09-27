// Pure "how should the 今すぐ監査 button's result banner read" mapping for
// tabs/AuditTab.tsx — kept separate so it can be unit-tested without
// mounting React. Only handles a *resolved* `kickoffAudit(...)` result: a
// thrown/rejected call is a different failure mode, rendered via
// lib/api.ts's `describeError` into its own error banner (see
// AuditTab.tsx's `handleKickoff`), so this never needs to represent that
// case.

import { isRecord, numOrNull } from "./coerce";

export const SKIP_REASONS: Record<string, string> = {
  audit_in_progress: "別の監査が実行中です",
  empty_period: "前回の監査以降の期間がまだありません",
  no_new_records: "前回の監査以降に新しい記録がありません",
  daily_budget_exceeded: "本日の予算を超過しています",
  concurrent_kickoff: "同時に別の監査が起動されました",
};

export function describeKickoff(result: unknown): string {
  if (!isRecord(result)) return "起動結果を読み取れませんでした";
  if (result.skipped === true) {
    const reason = typeof result.reason === "string" ? result.reason : "";
    return `スキップしました: ${SKIP_REASONS[reason] ?? reason}`;
  }
  const workItemId = numOrNull(result.work_item_id);
  return workItemId === null
    ? "監査を起動しました"
    : `監査を起動しました(work_item_id ${workItemId})`;
}
