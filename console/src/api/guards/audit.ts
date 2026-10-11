// console_queryの"audit_index"と"audit_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`AuditIndexRow`と`AuditDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_audit_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

// 作業項目の状態は表示にしか使わないので文字列で受け、日本語への変換(`labels.ts`)で知らない値を受け止める。
// 題名と要約は監査のClaudeが書いた文字列で、信頼しない。画面には文字としてだけ出す。

/** 監査レポートの一覧の1行。本文は持たない。 */
export type AuditIndexRow = {
  readonly audit_report_id: number;
  readonly work_item_id: number;
  readonly work_item_status: string;
  readonly title: string | null;
  readonly source: string;
  readonly period_start: string;
  readonly period_end: string;
  /** backendが対象期間の2つの時刻から作る表記(例: `2026-09-28〜2026-10-04`)。 */
  readonly period_label: string;
  readonly summary: string;
  readonly pending_count: number;
  readonly approved_count: number;
  readonly rejected_count: number;
  readonly created_at: string;
};

/** 監査レポート1件。一覧の行に、Markdownの本文を加えたもの。 */
export type AuditDocRow = AuditIndexRow & {
  readonly markdown: string;
  readonly metrics: Record<string, unknown>;
};

function isAuditIndexRow(value: unknown): value is AuditIndexRow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.audit_report_id) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.work_item_status) &&
    isNullableString(value.title) &&
    isString(value.source) &&
    isIsoTimestamp(value.period_start) &&
    isIsoTimestamp(value.period_end) &&
    isString(value.period_label) &&
    isString(value.summary) &&
    isNonNegativeInteger(value.pending_count) &&
    isNonNegativeInteger(value.approved_count) &&
    isNonNegativeInteger(value.rejected_count) &&
    isIsoTimestamp(value.created_at)
  );
}

function isAuditDocRow(value: unknown): value is AuditDocRow {
  return (
    isRecord(value) &&
    isString(value.markdown) &&
    isRecord(value.metrics) &&
    isAuditIndexRow(value)
  );
}

/** `value`が"audit_index"ビューの結果(行の配列)の形か。 */
export const isAuditIndexRows: Guard<AuditIndexRow[]> =
  isArrayOf(isAuditIndexRow);

/** `value`が"audit_doc"ビューの結果(行の配列)の形か。 */
export const isAuditDocRows: Guard<AuditDocRow[]> = isArrayOf(isAuditDocRow);
