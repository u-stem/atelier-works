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

/** 割合を百分率で返す。丸めると0になる正の割合は、小数1桁で出す。 */
function percent(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  return ratio > 0 && rounded === 0
    ? `${(ratio * 100).toFixed(1)}%`
    : `${String(rounded)}%`;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO文字列の時刻を、JSTの`HH:MM`で返す。 */
function jstClock(iso: string): string {
  const shifted = new Date(Date.parse(iso) + JST_OFFSET_MS);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function jobs(count: number | null): string {
  return count === null ? UNKNOWN : `${String(count)}件`;
}

function slotsLatest(load: WorkerLoad): string {
  const { running_jobs: running, slots } = load.latest;
  // 記録のジョブ自身が枠を1つ使うので、他のジョブが使える枠は1つ少ない。
  return running === null
    ? UNKNOWN
    : `${String(running)}件 / 他のジョブの上限${String(slots - 1)}件(${jstClock(load.latest.sampled_at)}時点)`;
}

/** 分母は、`running_jobs`が読めた記録だけにする。読めなかった記録は塞がりかどうか分からない。 */
function busySamples(load: WorkerLoad): string {
  const readable = load.running_readable_samples;
  if (readable === 0) {
    return UNKNOWN;
  }
  return `${String(load.busy_samples)}件(読めた記録${String(readable)}件中${percent(load.busy_samples / readable)})`;
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
  return `anon ${formatMebibytes(latest.mem_anon_bytes)}、working set ${formatMebibytes(latest.mem_working_set_bytes)}、${limit}(${jstClock(latest.sampled_at)}時点)`;
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

/** 結論の1行。枠が塞がっていた記録、開始が遅れた記録、メモリの最大の割合、記録の数を並べる。判定はしない。 */
export function describeWorkerLoadHeadline(load: WorkerLoad): string {
  const ratio = load.max.mem_anon_ratio;
  const memory = ratio === null ? UNKNOWN : percent(ratio);
  return `枠が塞がっていた記録${String(load.busy_samples)}件、開始が遅れた記録${String(load.lag_over_samples)}件、メモリの最大${memory}、記録${String(load.sample_count)}/${String(load.expected_count)}件`;
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
