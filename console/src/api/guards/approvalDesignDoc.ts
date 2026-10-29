// console_queryの"approval_design_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`ApprovalDesignDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_approval_design_doc_contract.test.ts`が落ちる。

import {
  isBoolean,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/**
 * `text`の本文の上限(コードポイント数)。backendの`DESIGN_FOR_IMPLEMENT_MAX_CHARS`と同じ値を写して持つ。
 * SPAはbackendの`model_text.ts`を読み込めないので写す。
 * 一致は`tests/scripts/console_approval_design_doc_contract.test.ts`が確かめる。
 */
export const DESIGN_TEXT_MAX_CODE_POINTS = 8000;

/** 切り詰めたときに、本文の後ろへ足される行。改行から始まる。 */
export const DESIGN_TRUNCATED_MARK_LINE = "\n[the design was truncated]";

/** 切り詰めた`text`の長さ(コードポイント数)。本文の上限に印の行を足したもの。 */
export const DESIGN_TEXT_MAX_WITH_MARK =
  DESIGN_TEXT_MAX_CODE_POINTS + [...DESIGN_TRUNCATED_MARK_LINE].length;

/**
 * コードポイント数を数える。`limit`を超えたら、そこで数えるのをやめて`limit + 1`を返す。
 * UTF-16の単位数は、コードポイント数以上、2倍以下なので、単位数が`limit`の2倍を超えれば、数えずに超えている。
 */
function codePointCount(text: string, limit: number): number {
  if (text.length > limit * 2) {
    return limit + 1;
  }
  let count = 0;
  for (const _char of text) {
    count += 1;
    if (count > limit) {
      return count;
    }
  }
  return count;
}

/**
 * `text`の長さが、`truncated`と合うか。
 * 切り詰めていないときは本文の上限以下、切り詰めたときは上限ちょうどで末尾が印の行である。
 * backendの正規化が守る形で、ずれた応答は描かずに断る。
 */
function isDesignTextWithinLimit(text: string, truncated: boolean): boolean {
  const count = codePointCount(text, DESIGN_TEXT_MAX_WITH_MARK);
  if (!truncated) {
    return count <= DESIGN_TEXT_MAX_CODE_POINTS;
  }
  return (
    count === DESIGN_TEXT_MAX_WITH_MARK &&
    text.endsWith(DESIGN_TRUNCATED_MARK_LINE)
  );
}

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
  /** 承認依頼の状態。表示にしか使わないので文字列として受ける。知らない値は呼び出し側が決まった文言に落とす。 */
  readonly approval_status: string;
};

function isApprovalDesignDoc(value: unknown): value is ApprovalDesignDoc {
  return (
    isRecord(value) &&
    isPositiveInteger(value.approval_request_id) &&
    isPositiveInteger(value.work_item_id) &&
    isPositiveInteger(value.design_attempt) &&
    isPositiveInteger(value.requirement_draft_id) &&
    isString(value.text) &&
    isBoolean(value.truncated) &&
    isDesignTextWithinLimit(value.text, value.truncated) &&
    isString(value.approval_status)
  );
}

/** 0件か1件の行。該当する設計書が無いときは0件になる。 */
export function isApprovalDesignDocRows(
  value: unknown,
): value is readonly ApprovalDesignDoc[] {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    value.every(isApprovalDesignDoc)
  );
}
