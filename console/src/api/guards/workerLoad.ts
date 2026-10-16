// console_queryの"system_status"ビューに載る、workerの負荷の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`WorkerLoadView`に合わせる。
// 値は数と時刻だけで、外部の文字列を含まない。

import {
  isInteger,
  isIsoTimestamp,
  isNullable,
  isRecord,
} from "./primitives.ts";

/** 有限の数。割合のような小数も通す。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const isNullableNumber = isNullable(isFiniteNumber);

/** 窓の中で最も新しい記録。読めなかった値は`null`。 */
export type WorkerLoadLatest = {
  readonly sampled_at: string;
  readonly slots: number;
  readonly running_jobs: number | null;
  readonly waiting_jobs: number | null;
  readonly max_wait_seconds: number | null;
  readonly lag_seconds: number | null;
  readonly mem_current_bytes: number | null;
  readonly mem_anon_bytes: number | null;
  readonly mem_working_set_bytes: number | null;
  readonly mem_peak_bytes: number | null;
  readonly mem_limit_bytes: number | null;
};

/** 窓の中の列ごとの最大。読めた値が無ければ`null`。 */
export type WorkerLoadMax = {
  readonly running_jobs: number | null;
  readonly waiting_jobs: number | null;
  readonly max_wait_seconds: number | null;
  readonly lag_seconds: number | null;
  readonly mem_current_bytes: number | null;
  readonly mem_anon_bytes: number | null;
  readonly mem_anon_ratio: number | null;
  readonly mem_working_set_bytes: number | null;
  readonly mem_peak_bytes: number | null;
};

/** 直近の窓でのdefaultのworkerの負荷。 */
export type WorkerLoad = {
  readonly window_hours: number;
  readonly sample_count: number;
  readonly expected_count: number;
  readonly latest: WorkerLoadLatest;
  readonly max: WorkerLoadMax;
  /** `running_jobs`が読めた記録の数。枠が塞がっていた記録の割合の分母。 */
  readonly running_readable_samples: number;
  readonly busy_samples: number;
  readonly lag_over_samples: number;
};

function isWorkerLoadLatest(value: unknown): value is WorkerLoadLatest {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.sampled_at) &&
    isInteger(value.slots) &&
    isNullableNumber(value.running_jobs) &&
    isNullableNumber(value.waiting_jobs) &&
    isNullableNumber(value.max_wait_seconds) &&
    isNullableNumber(value.lag_seconds) &&
    isNullableNumber(value.mem_current_bytes) &&
    isNullableNumber(value.mem_anon_bytes) &&
    isNullableNumber(value.mem_working_set_bytes) &&
    isNullableNumber(value.mem_peak_bytes) &&
    isNullableNumber(value.mem_limit_bytes)
  );
}

function isWorkerLoadMax(value: unknown): value is WorkerLoadMax {
  return (
    isRecord(value) &&
    isNullableNumber(value.running_jobs) &&
    isNullableNumber(value.waiting_jobs) &&
    isNullableNumber(value.max_wait_seconds) &&
    isNullableNumber(value.lag_seconds) &&
    isNullableNumber(value.mem_current_bytes) &&
    isNullableNumber(value.mem_anon_bytes) &&
    isNullableNumber(value.mem_anon_ratio) &&
    isNullableNumber(value.mem_working_set_bytes) &&
    isNullableNumber(value.mem_peak_bytes)
  );
}

/** `value`がworkerの負荷の形か。項目が足りない、型が違う値が入っていれば`false`。 */
export function isWorkerLoad(value: unknown): value is WorkerLoad {
  return (
    isRecord(value) &&
    isInteger(value.window_hours) &&
    isInteger(value.sample_count) &&
    isInteger(value.expected_count) &&
    isWorkerLoadLatest(value.latest) &&
    isWorkerLoadMax(value.max) &&
    isInteger(value.running_readable_samples) &&
    isInteger(value.busy_samples) &&
    isInteger(value.lag_over_samples)
  );
}
