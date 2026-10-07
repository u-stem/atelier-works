// 承認タブの行に出す種類のバッジの文言と、チェックボックスの初期値を決める関数。
// Reactをマウントせずに単体テストできるよう、`tabs/InboxTab.tsx`から分けている。

import type { InboxRow } from "./types";

export function kindLabel(row: InboxRow): string {
  if (row.kind === "requirements") return "要件定義";
  return row.origin === "audit" ? "改善提案" : "Issue化提案";
}

/**
 * 行を選んだときの「起票と同時にfactoryラベルを付けて要件定義に進める」
 * チェックボックスの初期値を返す。
 * 監査から出た`issue_proposal`(改善提案)ではオンにする。
 * 監査から起票したIssueは、すぐ要件定義の流れに戻す想定だからである。
 * それ以外はオフにする。PRレビューから出た`issue_proposal`は、
 * 依頼者自身のチェックボックスに従い、既定では起票だけにする。
 */
export function defaultWithFactoryLabel(row: InboxRow): boolean {
  return row.kind === "issue_proposal" && row.origin === "audit";
}
