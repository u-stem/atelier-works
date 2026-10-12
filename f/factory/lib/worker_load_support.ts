// defaultのworkerの負荷の記録(sample_worker_load)に使う、副作用の無い部品。
// コンテナのcgroupのファイルの解析、Windmillのqueueの応答の集計、連続して記録できなかった回数の数え方を持つ。
// queueの応答は信頼しない入力として読み、形が違う要素は数えない。

import type { ListQueueData } from "windmill-client@1.817.0";
import { isRecord, type NoticeRecord } from "./types.ts";

/** defaultのworkerの枠の数。`infra/docker-compose.yml`の`windmill_worker`の`NUM_WORKERS`と同じにする。 */
export const DEFAULT_WORKER_SLOTS = 3;

/** queueの取得で1回に読む件数。Windmillの上限でもある。 */
export const WORKER_SAMPLE_QUEUE_PER_PAGE = 100;

/** 実行中のジョブをscriptごとに記録するときの、キーの数の上限。超えた分は`other`にまとめる。 */
export const RUNNING_BY_SCRIPT_LIMIT = 10;

/** `running_by_script`で、上限を超えたscriptをまとめるキー。 */
export const RUNNING_BY_SCRIPT_OTHER_KEY = "other";

/** scriptのパスが取れないジョブをまとめるキー。 */
export const RUNNING_BY_SCRIPT_UNKNOWN_KEY = "unknown";

/** `running_by_script`のキーの長さの上限。 */
export const SCRIPT_KEY_MAX_LENGTH = 120;

/** 2分ごとの記録が、この回数続けて完全に取れなかったら、noticeにする(10分)。 */
export const WORKER_SAMPLE_FAILURE_LIMIT = 5;

/** 記録の間隔(分)。noticeの本文に入れる経過時間の計算に使う。 */
const SAMPLE_INTERVAL_MINUTES = 2;

/** Console用workerが受けるtag。defaultのworkerの枠を使わない。 */
const CONSOLE_TAG = "console";

/** nativeのworkerが受けるtagの先頭。defaultのworkerの枠を使わない。 */
const NATIVE_TAG_PREFIX = "native";

/**
 * フローの親ジョブのjob_kind。親ジョブはworkerの枠を使い続けず、実際の処理は子のscriptが枠を使うので数えない。
 */
const FLOW_PARENT_KINDS: readonly string[] = [
  "flow",
  "flowpreview",
  "unassigned_flow",
];

const WORKER_SAMPLE_FAILED_CAUSE = `defaultのworkerの負荷の記録を、${String(WORKER_SAMPLE_FAILURE_LIMIT * SAMPLE_INTERVAL_MINUTES)}分以上続けて完全には取れていません。枠の占有かメモリのどちらかが欠けた行ができています`;
const WORKER_SAMPLE_FAILED_ACTION =
  "f/factory/sample_worker_loadの直近のジョブログの警告を確かめる。queueの取得、cgroupの読み取り、DBへの記録のどれが失敗しているかが出る。factory.worker_samplesの直近の行でNULLの列も確かめる";

/**
 * 記録が続けて取れなかったことを知らせるnotice。本文は毎回同じ文にする。
 * 同じ本文の未解決のnoticeがあれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const WORKER_SAMPLE_FAILED_NOTICE: NoticeRecord = {
  kind: "worker_sample_failed",
  message: `${WORKER_SAMPLE_FAILED_CAUSE}。次の操作: ${WORKER_SAMPLE_FAILED_ACTION}`,
};

/** 実行中のジョブを取るAPIの引数。 */
export function runningQueueQuery(workspace: string): ListQueueData {
  return {
    workspace,
    running: true,
    perPage: WORKER_SAMPLE_QUEUE_PER_PAGE,
  };
}

/** 予定時刻を過ぎても開始していないジョブを取るAPIの引数。待ちが長いジョブを取りこぼさないよう、古いものから取る。 */
export function waitingQueueQuery(workspace: string): ListQueueData {
  return {
    workspace,
    running: false,
    scheduledForBeforeNow: true,
    orderDesc: false,
    perPage: WORKER_SAMPLE_QUEUE_PER_PAGE,
  };
}

// ---------------------------------------------------------------------------
// cgroup
// ---------------------------------------------------------------------------

/** cgroupのファイルの内容。読めなかったものは`null`。 */
export type CgroupTexts = {
  readonly current: string | null;
  readonly peak: string | null;
  readonly max: string | null;
  readonly stat: string | null;
  readonly events: string | null;
  readonly pressure: string | null;
};

/** 解析したメモリの値(バイト、回数、マイクロ秒)。読めなかった値は`null`。 */
export type MemorySample = {
  readonly current: number | null;
  readonly anon: number | null;
  readonly workingSet: number | null;
  readonly peak: number | null;
  readonly limit: number | null;
  readonly eventsMax: number | null;
  readonly oom: number | null;
  readonly oomKill: number | null;
  readonly pressureTotalUs: number | null;
};

/** 0以上の整数だけを数として読む。空、負、小数、安全な整数を超える値は`null`にする。 */
function parseCounter(text: string | null | undefined): number | null {
  if (text === null || text === undefined) {
    return null;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** `key value`の行が並ぶファイル(memory.stat、memory.events)から、キーの値を読む。 */
function parseKeyedCounter(text: string | null, key: string): number | null {
  if (text === null) {
    return null;
  }
  for (const line of text.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      return parseCounter(value);
    }
  }
  return null;
}

/** memory.pressureの`some`の行の`total`(マイクロ秒の累積)を読む。 */
function parsePressureTotal(text: string | null): number | null {
  if (text === null) {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("some ")) {
      continue;
    }
    const match = /\btotal=(\d+)\b/.exec(line);
    return parseCounter(match?.[1]);
  }
  return null;
}

/**
 * cgroup v2のメモリのファイルを解析する。
 * 読めないファイルや読めない値は`null`にして、ほかの値は残す。
 * `memory.max`が`max`なら上限なしとして`null`にする。
 * 作業セットは`memory.current`から`memory.stat`の`inactive_file`を引いた値で、0を下回らない。
 */
export function parseCgroupMemory(texts: CgroupTexts): MemorySample {
  const current = parseCounter(texts.current);
  const inactiveFile = parseKeyedCounter(texts.stat, "inactive_file");
  return {
    current,
    anon: parseKeyedCounter(texts.stat, "anon"),
    workingSet:
      current !== null && inactiveFile !== null
        ? Math.max(0, current - inactiveFile)
        : null,
    peak: parseCounter(texts.peak),
    limit: parseCounter(texts.max),
    eventsMax: parseKeyedCounter(texts.events, "max"),
    oom: parseKeyedCounter(texts.events, "oom"),
    oomKill: parseKeyedCounter(texts.events, "oom_kill"),
    pressureTotalUs: parsePressureTotal(texts.pressure),
  };
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

/**
 * defaultのworkerの枠を使うジョブか。
 * tag `console`はConsole用のworker、`native`で始まるtagはnativeのworkerが受けるので、数えない。
 * フローの親ジョブも数えない。tagが読めないものは、どこで動くか分からないので数えない。
 */
function usesDefaultSlot(job: Record<string, unknown>): boolean {
  const tag = job.tag;
  if (typeof tag !== "string") {
    return false;
  }
  if (tag === CONSOLE_TAG || tag.startsWith(NATIVE_TAG_PREFIX)) {
    return false;
  }
  const kind = job.job_kind;
  return !(typeof kind === "string" && FLOW_PARENT_KINDS.includes(kind));
}

/** 実行中のジョブの集計。 */
export type RunningSummary = {
  readonly count: number;
  readonly byScript: Record<string, number>;
};

function scriptKey(job: Record<string, unknown>): string {
  const path = job.script_path;
  if (typeof path !== "string" || path.length === 0) {
    return RUNNING_BY_SCRIPT_UNKNOWN_KEY;
  }
  return path.slice(0, SCRIPT_KEY_MAX_LENGTH);
}

/** 件数の多い順(同数ならキーの順)に`RUNNING_BY_SCRIPT_LIMIT`件を残し、残りを`other`にまとめる。 */
function foldScripts(counts: Map<string, number>): Record<string, number> {
  const entries = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const result: Record<string, number> = {};
  let rest = 0;
  entries.forEach(([key, count], index) => {
    if (index < RUNNING_BY_SCRIPT_LIMIT) {
      result[key] = count;
    } else {
      rest += count;
    }
  });
  if (rest > 0) {
    result[RUNNING_BY_SCRIPT_OTHER_KEY] = rest;
  }
  return result;
}

/**
 * 実行中のジョブの応答から、defaultのworkerの枠を使うジョブの数とscriptごとの内訳を集計する。
 * `selfJobId`のジョブ(記録するジョブ自身)は数えない。応答が配列でなければ`null`を返す。
 */
export function summarizeRunning(
  response: unknown,
  selfJobId: string | null,
): RunningSummary | null {
  if (!Array.isArray(response)) {
    return null;
  }
  const counts = new Map<string, number>();
  let count = 0;
  for (const job of response) {
    if (
      !isRecord(job) ||
      job.running !== true ||
      (selfJobId !== null && job.id === selfJobId) ||
      !usesDefaultSlot(job)
    ) {
      continue;
    }
    count += 1;
    const key = scriptKey(job);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { count, byScript: foldScripts(counts) };
}

/** 待っているジョブの集計。`maxWaitSeconds`は、待つジョブが無ければ0。 */
export type WaitingSummary = {
  readonly count: number;
  readonly maxWaitSeconds: number;
};

/**
 * 予定時刻を過ぎても開始していないジョブの応答から、待っているジョブの数と最長の待ち時間(秒)を集計する。
 * 数えるのは、実行中でなく、中断されておらず、予定時刻が`nowMs`以前で日時として読めるものだけにする。
 * 予定時刻が未来のジョブは、待たされていないので数えない。応答が配列でなければ`null`を返す。
 */
export function summarizeWaiting(
  response: unknown,
  nowMs: number,
): WaitingSummary | null {
  if (!Array.isArray(response)) {
    return null;
  }
  let count = 0;
  let maxWaitMs = 0;
  for (const job of response) {
    if (
      !isRecord(job) ||
      job.running === true ||
      (typeof job.suspend === "number" && job.suspend > 0) ||
      !usesDefaultSlot(job)
    ) {
      continue;
    }
    const scheduledMs = parseTimeMs(job.scheduled_for);
    if (scheduledMs === null || scheduledMs > nowMs) {
      continue;
    }
    count += 1;
    maxWaitMs = Math.max(maxWaitMs, nowMs - scheduledMs);
  }
  return { count, maxWaitSeconds: Math.floor(maxWaitMs / 1000) };
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 応答の配列から、IDが一致するジョブを返す。無いとき、応答が配列でないとき、IDが無いときは`null`。 */
export function findJobById(
  response: unknown,
  id: string | null,
): Record<string, unknown> | null {
  if (id === null || !Array.isArray(response)) {
    return null;
  }
  for (const job of response) {
    if (isRecord(job) && job.id === id) {
      return job;
    }
  }
  return null;
}

/** 記録するジョブ自身の予定時刻と、予定時刻から開始までの遅れ(秒)。読めなければ`null`。 */
export type JobTiming = {
  readonly scheduledFor: Date | null;
  readonly lagSeconds: number | null;
};

/** ジョブの情報から予定時刻と遅れを読む。遅れは負にならず、整数の秒に丸める。 */
export function timingOf(job: unknown): JobTiming {
  if (!isRecord(job)) {
    return { scheduledFor: null, lagSeconds: null };
  }
  const scheduledMs = parseTimeMs(job.scheduled_for);
  const startedMs = parseTimeMs(job.started_at);
  return {
    scheduledFor: scheduledMs === null ? null : new Date(scheduledMs),
    lagSeconds:
      scheduledMs !== null && startedMs !== null
        ? Math.max(0, Math.round((startedMs - scheduledMs) / 1000))
        : null,
  };
}

// ---------------------------------------------------------------------------
// 連続して取れなかった回数
// ---------------------------------------------------------------------------

/** 保存したstateから、完全には取れなかった連続の回数を読む。読めなければ0。 */
export function parseFailureCount(state: unknown): number {
  if (!isRecord(state)) {
    return 0;
  }
  const count = state.worker_sample_failure_count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0
    ? count
    : 0;
}

/** 完全には取れなかったときは1足し、取れたときは0に戻す。 */
export function nextFailureCount(previous: number, complete: boolean): number {
  return complete ? 0 : previous + 1;
}
