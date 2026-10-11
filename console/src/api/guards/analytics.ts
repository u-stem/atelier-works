// console_queryの"agent_cost_daily"、"approval_stats"、"lead_time"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の同名の行の型に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_analytics_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullable,
  isNullableInteger,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/** 有限の数。費用や所要時間のように、整数とは限らない値に使う。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const isNullableFiniteNumber = isNullable(isFiniteNumber);

/** 日、段階、モデルごとのClaudeの実行の集計1行。 */
export type AgentCostDailyRow = {
  readonly day: string;
  readonly stage: string;
  readonly model: string;
  readonly run_count: number;
  readonly total_cost_usd: number | null;
  readonly total_input_tokens: number | null;
  readonly total_output_tokens: number | null;
  readonly total_cache_read_tokens: number | null;
  readonly total_turns: number | null;
  readonly avg_duration_ms: number | null;
};

/** 日、判断、試行ごとの承認の判断の件数1行。 */
export type ApprovalStatsRow = {
  readonly day: string;
  readonly decision: string;
  readonly attempt: number;
  readonly decision_count: number;
};

/** 終端になった作業項目1件の、作成から終端までの時間。 */
export type LeadTimeRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly lead_time_seconds: number;
};

function isAgentCostDailyRow(value: unknown): value is AgentCostDailyRow {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.day) &&
    isString(value.stage) &&
    isString(value.model) &&
    isNonNegativeInteger(value.run_count) &&
    isNullableFiniteNumber(value.total_cost_usd) &&
    isNullableFiniteNumber(value.total_input_tokens) &&
    isNullableFiniteNumber(value.total_output_tokens) &&
    isNullableFiniteNumber(value.total_cache_read_tokens) &&
    isNullableFiniteNumber(value.total_turns) &&
    isNullableFiniteNumber(value.avg_duration_ms)
  );
}

function isApprovalStatsRow(value: unknown): value is ApprovalStatsRow {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.day) &&
    isString(value.decision) &&
    isPositiveInteger(value.attempt) &&
    isNonNegativeInteger(value.decision_count)
  );
}

function isLeadTimeRow(value: unknown): value is LeadTimeRow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableInteger(value.issue_number) &&
    isString(value.status) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.updated_at) &&
    isFiniteNumber(value.lead_time_seconds)
  );
}

/** `value`が"agent_cost_daily"ビューの結果(行の配列)の形か。 */
export const isAgentCostDailyRows: Guard<AgentCostDailyRow[]> =
  isArrayOf(isAgentCostDailyRow);

/** `value`が"approval_stats"ビューの結果(行の配列)の形か。 */
export const isApprovalStatsRows: Guard<ApprovalStatsRow[]> =
  isArrayOf(isApprovalStatsRow);

/** `value`が"lead_time"ビューの結果(行の配列)の形か。 */
export const isLeadTimeRows: Guard<LeadTimeRow[]> = isArrayOf(isLeadTimeRow);
