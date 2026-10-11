// console_queryの"inbox"ビューの応答のうち、Issue提案の承認に要る部分の型と型ガード。
// 提案の本文と、factoryラベルの選択肢の出し分けは、summaryに載せていないので、このビューから読む。
// 型は`f/factory/steps/console_query.ts`の`IssueProposalInboxRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_inbox_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isBoolean,
  isNullableInteger,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/** Issue提案の承認依頼の1行。出どころは文字列で受け、知らない値は画面で監査以外として扱う。 */
export type InboxProposal = {
  readonly approval_request_id: number;
  readonly kind: "issue_proposal";
  readonly proposal_title: string;
  readonly proposal_body: string;
  readonly pr_number: number | null;
  readonly claimed_by: string | null;
  readonly origin: string;
  readonly period_label: string | null;
  readonly factory_label_available: boolean;
};

/** Issue提案でない行。承認依頼のidと種類だけを確かめ、ほかの項目は読まない。 */
type InboxOtherRow = {
  readonly approval_request_id: number;
  readonly kind: string;
};

type InboxRow = InboxProposal | InboxOtherRow;

export function isInboxProposal(value: unknown): value is InboxProposal {
  return (
    isRecord(value) &&
    isPositiveInteger(value.approval_request_id) &&
    value.kind === "issue_proposal" &&
    isString(value.proposal_title) &&
    isString(value.proposal_body) &&
    isNullableInteger(value.pr_number) &&
    isNullableString(value.claimed_by) &&
    isString(value.origin) &&
    isNullableString(value.period_label) &&
    isBoolean(value.factory_label_available)
  );
}

function isInboxRow(value: unknown): value is InboxRow {
  if (!isRecord(value) || !isString(value.kind)) {
    return false;
  }
  return value.kind === "issue_proposal"
    ? isInboxProposal(value)
    : isPositiveInteger(value.approval_request_id);
}

/** `value`が"inbox"ビューの結果の形か。提案の行の項目が足りなければ`false`。 */
export const isInboxRows: Guard<InboxRow[]> = isArrayOf(isInboxRow);
