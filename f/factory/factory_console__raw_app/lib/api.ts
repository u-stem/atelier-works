// このAppのバックエンドのrunnableを呼ぶ、
// 生成された`./wmill`のバインディングの薄いラッパー。
// runnableはすべて既存のスクリプトへの参照
// (`../backend/*.yaml`の`type: script`)なので、ここにSQLや業務ロジックは無い。

import { backend } from "../wmill";
import type { ConsoleView } from "./types";

/**
 * `f/factory/steps/console_query.ts`を呼び、結果を`unknown`のまま返す。
 * 呼び出し側が`lib/types.ts`の`to*Row`で各要素を変換する
 * (例外を投げずに既定値へ落とす。理由は`lib/coerce.ts`の冒頭を参照)。
 * `work_item_id`は"requirements_doc"と"audit_doc"のビューで、
 * `attempt`は"requirements_doc"のビューでだけ使い、
 * それ以外のビューではサーバー側で無視される。
 */
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

/**
 * `f/factory/approval_decide.ts`を呼び、承認依頼への判断を記録する。
 * このスクリプトは、すべての種類の`approval_requests`について
 * 判断を記録する唯一の入口である。
 * `action`が`"reject"`のとき`reason`は必須で、空白だけならスクリプト側で失敗する。
 * `note`は任意の補足の自由記述。
 * `options`は種類ごとの判断側のデータで
 * (例: `"issue_proposal"`の依頼では`{ with_factory_label: boolean }`)、
 * 省略すると`{}`になる。
 */
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

/** `f/factory/retry_work_item.ts`を呼び、止まった作業項目を再開する。 */
export async function retryWorkItem(workItemId: number): Promise<unknown> {
  return await backend.retry_work_item({ work_item_id: workItemId });
}

/**
 * 監査タブの「今すぐ監査」ボタンから`f/factory/audit_kickoff.ts`を呼ぶ。
 * `days`は、監査レポートがまだ1件も無いときだけ使われる。
 */
export async function kickoffAudit(days: number | undefined): Promise<unknown> {
  return await backend.audit_kickoff({ days, force: false, source: "manual" });
}

/**
 * 投げられた値を、画面に出す短いメッセージにして返す。
 * Windmillのジョブのエラーはふつう`Error`で、`message`にバックエンドの
 * スクリプトの文言がそのまま入っているため、それを使う。
 * `Error`以外(文字列など)で失敗した場合も扱う。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "不明なエラーが発生しました";
}
