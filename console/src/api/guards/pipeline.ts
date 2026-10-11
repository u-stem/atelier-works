// console_queryの"pipeline"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`PipelineRow`のうち、画面が読む列に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_pipeline_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullable,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

// 状態と種別は表示にしか使わないので文字列で受け、日本語への変換(`labels.ts`)で知らない値を受け止める。
// backendが先に新しい値を反映した間も、一覧の全体が消えないためである。

/** 作業項目1件の進捗。題名、ブランチ、URLは信頼できない文字列で、画面には検査してから出す。 */
export type PipelineRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly kind: string;
  readonly pr_number: number | null;
  readonly fix_round: number;
  readonly branch: string | null;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

const isNullablePositiveInteger = isNullable(isPositiveInteger);

function isPipelineRow(value: unknown): value is PipelineRow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullablePositiveInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableString(value.title) &&
    isString(value.status) &&
    isNonNegativeInteger(value.attempt) &&
    isString(value.kind) &&
    isNullablePositiveInteger(value.pr_number) &&
    isNonNegativeInteger(value.fix_round) &&
    isNullableString(value.branch) &&
    isNullableString(value.pr_url) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.updated_at)
  );
}

/** `value`が"pipeline"ビューの結果(作業項目の配列)の形か。 */
export const isPipelineRows: Guard<PipelineRow[]> = isArrayOf(isPipelineRow);
