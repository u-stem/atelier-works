// console_queryの"work_item_detail"ビューのうち、失敗の行の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`WorkItemFailureRow`に合わせる。
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
 * 作業項目に紐づく失敗の1行。
 * `job_id`は失敗の記録に渡されたジョブで、フローの失敗ではフローのルート、ステップの中の記録ではそのステップのジョブ。
 * `root_job_id`は記録したジョブのルートジョブ。どちらもUUIDの形のものだけで、無いか形が違えば`null`。
 */
export type WorkItemFailure = {
  readonly job_failure_id: number;
  readonly flow_path: string;
  readonly job_id: string | null;
  readonly root_job_id: string | null;
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
};

const isNullableJobId: Guard<string | null> = isNullable(isJobId);

export function isWorkItemFailure(value: unknown): value is WorkItemFailure {
  return (
    isRecord(value) &&
    isPositiveInteger(value.job_failure_id) &&
    isString(value.flow_path) &&
    isNullableJobId(value.job_id) &&
    isNullableJobId(value.root_job_id) &&
    isNullableString(value.step) &&
    isString(value.error) &&
    isIsoTimestamp(value.occurred_at)
  );
}

/** 要素がすべて失敗の行の形の配列か。 */
export const isWorkItemFailureList: Guard<WorkItemFailure[]> =
  isArrayOf(isWorkItemFailure);
