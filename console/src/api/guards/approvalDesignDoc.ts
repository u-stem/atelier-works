// console_queryの"approval_design_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`ApprovalDesignDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_approval_design_doc_contract.test.ts`が落ちる。

/** 承認依頼の状態。 */
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

/**
 * 承認依頼が指す設計書。`text`は、承認後の実装が受け取る文字そのものである。
 * 秘密値のマスクと制御文字の除去を済ませ、長すぎるときは切ってある。
 * 信頼できない入力を読んだ出力なので、文字として描き、解釈しない。
 */
export type ApprovalDesignDoc = {
  readonly approval_request_id: number;
  readonly work_item_id: number;
  readonly design_attempt: number;
  readonly requirement_draft_id: number;
  readonly text: string;
  /** `text`が長さの上限で切られ、末尾に印の行が付いているか。 */
  readonly truncated: boolean;
  readonly approval_status: ApprovalRequestStatus;
};

/** 0件か1件の行。該当する設計書が無いときは0件になる。 */
export function isApprovalDesignDocRows(
  _value: unknown,
): _value is readonly ApprovalDesignDoc[] {
  return false;
}
