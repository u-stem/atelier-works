// console_queryの"work_item_detail"ビューのうち、状態の遷移とジョブIDの部分の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`WorkItemTransitionRow`に合わせる。
// backendの型を変えたら`tests/scripts/console_work_item_jobs_contract.test.ts`が落ちる。

import { isJobId } from "../../lib/jobLink.ts";
import {
  type Guard,
  isArrayOf,
  isIsoTimestamp,
  isNullable,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/**
 * 状態の遷移1回分。`job_id`は遷移を起こしたステップのジョブ、`root_job_id`はそのステップを含むフローのジョブ。
 * ジョブの無い遷移では両方`null`。
 */
export type WorkItemTransition = {
  readonly event_id: number;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly note: string | null;
  readonly occurred_at: string;
  readonly job_id: string | null;
  readonly root_job_id: string | null;
};

const isNullableJobId: Guard<string | null> = isNullable(isJobId);

export function isWorkItemTransition(
  value: unknown,
): value is WorkItemTransition {
  return (
    isRecord(value) &&
    isPositiveInteger(value.event_id) &&
    isNullableString(value.from_status) &&
    isString(value.to_status) &&
    isNullableString(value.note) &&
    isIsoTimestamp(value.occurred_at) &&
    isNullableJobId(value.job_id) &&
    isNullableJobId(value.root_job_id)
  );
}

/** 要素がすべて遷移の形の配列か。 */
export const isWorkItemTransitionList: Guard<WorkItemTransition[]> =
  isArrayOf(isWorkItemTransition);
