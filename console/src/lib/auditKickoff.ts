// 監査の手動起動で、確認と結果に出す文言。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type { AuditKickoffResult } from "../api/guards/writeResults.ts";
import { describeAuditResult, STALE_LIST_NOTICE } from "./writeNotices.ts";

/** 起動前の確認ダイアログの文言。 */
export const AUDIT_KICKOFF_CONFIRM = {
  title: "監査を今すぐ起動しますか",
  description:
    "前回の監査以降の運用記録をClaudeが調べ、監査レポートと改善提案を作ります。Claudeの実行は日次の予算を使います。対象の記録が無いときや、別の監査が進行中のときは、起動せずに理由を伝えます。",
  confirmLabel: "起動する",
  cancelLabel: "やめる",
} as const;

/** 画面に残す結果の知らせ。`error`は、書き込みが失敗したことを表す。 */
export type AuditKickoffNotice = {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly message: string;
};

/** 起動の結果を、画面に残す知らせにする。見送りは失敗ではなく、何も変えなかった結果として伝える。 */
export function auditKickoffNotice(
  outcome: WriteOutcome<AuditKickoffResult>,
): AuditKickoffNotice {
  if (outcome.kind === "failed") {
    return { tone: "error", message: outcome.message };
  }
  return describeAuditResult(outcome.result);
}

/** 起動の後に一覧を読み直せなかったときの知らせ。 */
export function staleAuditNotice(): AuditKickoffNotice {
  return { tone: STALE_LIST_NOTICE.tone, message: STALE_LIST_NOTICE.message };
}
