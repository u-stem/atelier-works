// `tabs/AuditTab.tsx`の「今すぐ監査」ボタンを押した後に出す結果の文言を決める関数。
// Reactをマウントせずに単体テストできるよう分けている。
// 扱うのは`kickoffAudit(...)`が正常に返した結果だけである。
// 呼び出しが例外で失敗した場合は、`AuditTab.tsx`の`handleKickoff`が
// `lib/api.ts`の`describeError`で別のエラー表示にする。

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
