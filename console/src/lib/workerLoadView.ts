// システムの画面の「workerの負荷」が出す内容を決める純関数。
// 値は数だけで、外部の文字列を含まない。読めなかった値は「不明」と出す。

import type { WorkerLoad } from "../api/guards/workerLoad.ts";

const BYTES_PER_MIB = 1024 * 1024;

export type WorkerLoadRow = {
  readonly label: string;
  readonly value: string;
};

export type WorkerLoadDescription = {
  /** 窓の長さと、記録の数。 */
  readonly coverage: string;
  readonly rows: readonly WorkerLoadRow[];
};

const UNKNOWN = "不明";

/** バイトをMiBの整数で返す。読めなければ「不明」。 */
export function formatMebibytes(bytes: number | null): string {
  return bytes === null
    ? UNKNOWN
    : `${String(Math.round(bytes / BYTES_PER_MIB))}MiB`;
}

function percent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

function jobs(count: number | null): string {
  return count === null ? UNKNOWN : `${String(count)}件`;
}

function slotsLatest(load: WorkerLoad): string {
  const { running_jobs: running, slots } = load.latest;
  // 記録のジョブ自身が枠を1つ使うので、他のジョブが使える枠は1つ少ない。
  return running === null
    ? UNKNOWN
    : `${String(running)}件 / 他のジョブの上限${String(slots - 1)}件`;
}

function busySamples(load: WorkerLoad): string {
  const share =
    load.sample_count === 0 ? 0 : load.busy_samples / load.sample_count;
  return `${String(load.busy_samples)}件(${String(load.sample_count)}件中${percent(share)})`;
}

function waitMax(load: WorkerLoad): string {
  const { max_wait_seconds: wait, waiting_jobs: waiting } = load.max;
  if (wait === null) {
    return UNKNOWN;
  }
  return `待ち${String(wait)}秒以上、待つジョブ最大${jobs(waiting)}`;
}

function lateSamples(load: WorkerLoad): string {
  const { lag_seconds: lag } = load.max;
  return `${String(load.lag_over_samples)}件${
    lag === null ? "" : `(最大${String(lag)}秒)`
  }`;
}

function memoryLatest(load: WorkerLoad): string {
  const { latest } = load;
  const limit =
    latest.mem_limit_bytes === null
      ? "上限不明"
      : `上限${formatMebibytes(latest.mem_limit_bytes)}`;
  return `anon ${formatMebibytes(latest.mem_anon_bytes)}、working set ${formatMebibytes(latest.mem_working_set_bytes)}、${limit}`;
}

function memoryMax(load: WorkerLoad): string {
  const { max } = load;
  const share =
    max.mem_anon_ratio === null ? "" : `(上限の${percent(max.mem_anon_ratio)})`;
  return `anon ${formatMebibytes(max.mem_anon_bytes)}${share}、working set ${formatMebibytes(max.mem_working_set_bytes)}`;
}

function currentAndPeak(load: WorkerLoad): string {
  const { latest } = load;
  return `${formatMebibytes(latest.mem_current_bytes)} / ${formatMebibytes(latest.mem_peak_bytes)}(キャッシュを含む)`;
}

/** 直近の窓の負荷を、画面に出す行にする。 */
export function describeWorkerLoad(load: WorkerLoad): WorkerLoadDescription {
  return {
    coverage: `直近${String(load.window_hours)}時間: ${String(load.sample_count)}/${String(load.expected_count)}件`,
    rows: [
      { label: "枠の使用(最新)", value: slotsLatest(load) },
      { label: "枠の使用(最大)", value: jobs(load.max.running_jobs) },
      { label: "枠が塞がっていた記録", value: busySamples(load) },
      { label: "queueの待ち(最大)", value: waitMax(load) },
      { label: "開始が遅れた記録", value: lateSamples(load) },
      { label: "メモリ(最新)", value: memoryLatest(load) },
      { label: "メモリ(最大)", value: memoryMax(load) },
      { label: "memory.current / memory.peak", value: currentAndPeak(load) },
    ],
  };
}
