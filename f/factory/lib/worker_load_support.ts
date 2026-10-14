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

/**
 * defaultのworkerグループが受けるtag。Windmillの既定の割り当てで、
 * `infra/docker-compose.yml`の`windmill_worker`は`WORKER_TAGS`を設定しないので、これが使われる。
 * 実機では、tag `bun`のジョブがdefaultのworkerで動き、tag `postgresql`のプレビュー
 * (`wmill.datatable()`のクエリ)がnativeのworkerで動くことを確かめている。
 * tag `console`はConsole用のworker、`nativets`、`bunnative`、`postgresql`、`mysql`、`mssql`、
 * `graphql`、`snowflake`、`bigquery`、`oracledb`はnativeのworkerが受けるので、このリストに入れない。
 * 誰も受けないtagのジョブは動かないので、実行中にも待ちにも数えない。
 * 次の`OTHER_WORKER_TAGS`にも無いtagは、警告に出す。
 */
const DEFAULT_WORKER_TAGS: ReadonlySet<string> = new Set([
  "deno",
  "python3",
  "go",
  "bash",
  "powershell",
  "dependency",
  "flow",
  "hub",
  "bun",
  "php",
  "rust",
  "ansible",
  "csharp",
  "java",
  "nu",
  "ruby",
  "duckdb",
  "dbt",
  "other",
]);

/**
 * defaultのworkerの枠を使わないと分かっているtag。Console用のworkerとnativeのworkerが受ける。
 * これらは数えない。ここにも`DEFAULT_WORKER_TAGS`にも無いtagは、受けるworkerが分からないので警告に出す。
 */
const OTHER_WORKER_TAGS: ReadonlySet<string> = new Set([
  "console",
  "nativets",
  "bunnative",
  "postgresql",
  "mysql",
  "mssql",
  "graphql",
  "snowflake",
  "bigquery",
  "oracledb",
]);

/** 警告に出す未知のtagの名前の長さの上限。 */
const UNKNOWN_TAG_MAX_LENGTH = 60;

/**
 * フローの親ジョブのjob_kind。親ジョブは動き出した後はworkerの枠を使い続けず、実際の処理は子のscriptが
 * 枠を使うので、実行中には数えない。まだ始まっていない親は、枠が空くのを待つので待ちに数える。
 * 単一ステップのフロー(`singlestepflow`)の親は、枠を使うかどうかを確かめていないので、除かない。
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
 * 呼び出し1回に許す時間(ミリ秒)。1回の上限と、全体の締め切りまでの残りの短い方を返す。
 * 0以下なら締め切りを過ぎているので、呼び出しを飛ばす。
 */
export function remainingCallMs(
  deadlineMs: number,
  nowMs: number,
  perCallMs: number,
): number {
  return Math.max(0, Math.min(perCallMs, deadlineMs - nowMs));
}

/** tagとjob_kindが文字列で読めるジョブ。読めなければ`null`。 */
type KindedJob = {
  readonly tag: string;
  readonly kind: string;
};

function kindedJob(job: Record<string, unknown>): KindedJob | null {
  return typeof job.tag === "string" && typeof job.job_kind === "string"
    ? { tag: job.tag, kind: job.job_kind }
    : null;
}

/** defaultのworkerが受けるtagのジョブか。 */
function onDefaultWorker(job: KindedJob): boolean {
  return DEFAULT_WORKER_TAGS.has(job.tag);
}

/** 受けるworkerが分からないtagのジョブ。数えずに警告に出す。 */
export type UnknownTags = {
  /** そのtagのジョブの件数。 */
  readonly jobs: number;
  /** 重複を除いたtag名を、辞書順に並べたもの。長いものは切り詰める。 */
  readonly tags: readonly string[];
};

function isUnknownTag(tag: string): boolean {
  return !DEFAULT_WORKER_TAGS.has(tag) && !OTHER_WORKER_TAGS.has(tag);
}

function unknownTagsOf(counts: ReadonlyMap<string, number>): UnknownTags {
  let jobs = 0;
  for (const count of counts.values()) {
    jobs += count;
  }
  return { jobs, tags: [...counts.keys()].sort() };
}

function noteUnknownTag(counts: Map<string, number>, tag: string): void {
  const name = tag.slice(0, UNKNOWN_TAG_MAX_LENGTH);
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** 実行中と待ちの未知のtagをまとめる。 */
export function combineUnknownTags(
  first: UnknownTags,
  second: UnknownTags,
): UnknownTags {
  return {
    jobs: first.jobs + second.jobs,
    tags: [...new Set([...first.tags, ...second.tags])].sort(),
  };
}

/** 実行中のジョブの集計。 */
export type RunningSummary = {
  readonly count: number;
  /** 受けるworkerが分からないtagのジョブ。`count`には入らない。 */
  readonly unknownTags: UnknownTags;
  readonly byScript: Record<string, number>;
  /** 形が読めず、数えなかった要素の数。 */
  readonly malformed: number;
  /**
   * 記録するジョブ自身を、一覧から正しく読めたか。
   * 100件未満の一覧には、実行中の自分が必ずある。無い、またはtagとjob_kindが読めないときは、
   * 応答の形が変わったと見なして`false`にする。100件の一覧は打ち切られているので、無くてもよい。
   */
  readonly selfReadable: boolean;
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

function selfIsReadable(
  response: readonly unknown[],
  selfJobId: string | null,
  pageSize: number,
): boolean {
  if (selfJobId === null) {
    return true;
  }
  const self = findJobById(response, selfJobId);
  if (self === null) {
    return response.length >= pageSize;
  }
  return kindedJob(self) !== null;
}

/**
 * 実行中のジョブの応答から、defaultのworkerの枠を使うジョブの数とscriptごとの内訳を集計する。
 * `selfJobId`のジョブ(記録するジョブ自身)は数えない。
 * 数えるのは、defaultのworkerが受けるtagで、フローの親ジョブでないものである。
 * 応答が配列でないとき、空でないのにすべての要素の形が読めないときは`null`を返す。
 */
export function summarizeRunning(
  response: unknown,
  selfJobId: string | null,
  pageSize: number = WORKER_SAMPLE_QUEUE_PER_PAGE,
): RunningSummary | null {
  if (!Array.isArray(response)) {
    return null;
  }
  const counts = new Map<string, number>();
  const unknown = new Map<string, number>();
  let count = 0;
  let malformed = 0;
  for (const job of response) {
    if (!isRecord(job) || typeof job.running !== "boolean") {
      malformed += 1;
      continue;
    }
    if (!job.running || (selfJobId !== null && job.id === selfJobId)) {
      continue;
    }
    const kinded = kindedJob(job);
    if (kinded === null) {
      malformed += 1;
      continue;
    }
    if (isUnknownTag(kinded.tag)) {
      noteUnknownTag(unknown, kinded.tag);
    }
    if (!onDefaultWorker(kinded) || FLOW_PARENT_KINDS.includes(kinded.kind)) {
      continue;
    }
    count += 1;
    const key = scriptKey(job);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (response.length > 0 && malformed === response.length) {
    return null;
  }
  return {
    count,
    unknownTags: unknownTagsOf(unknown),
    byScript: foldScripts(counts),
    malformed,
    selfReadable: selfIsReadable(response, selfJobId, pageSize),
  };
}

/** 待っているジョブの集計。`maxWaitSeconds`は、待つジョブが無ければ0。 */
export type WaitingSummary = {
  readonly count: number;
  /** 受けるworkerが分からないtagのジョブ。`count`には入らない。 */
  readonly unknownTags: UnknownTags;
  readonly maxWaitSeconds: number;
  /** 形が読めず、数えなかった要素の数。 */
  readonly malformed: number;
};

/**
 * 予定時刻を過ぎても開始していないジョブの応答から、待っているジョブの数と最長の待ち時間(秒)を集計する。
 * 数えるのは、実行中でなく、中断されておらず、defaultのworkerが受けるtagで、
 * 予定時刻が`nowMs`以前のジョブである。まだ始まっていないフローの親も、枠が空くのを待つので数える。
 * 予定時刻が未来のジョブは、待たされていないので数えない。
 * 応答が配列でないとき、空でないのにすべての要素の形が読めないときは`null`を返す。
 */
export function summarizeWaiting(
  response: unknown,
  nowMs: number,
): WaitingSummary | null {
  if (!Array.isArray(response)) {
    return null;
  }
  const unknown = new Map<string, number>();
  let count = 0;
  let malformed = 0;
  let maxWaitMs = 0;
  for (const job of response) {
    if (!isRecord(job) || typeof job.running !== "boolean") {
      malformed += 1;
      continue;
    }
    if (job.running || (typeof job.suspend === "number" && job.suspend > 0)) {
      continue;
    }
    const kinded = kindedJob(job);
    const scheduledMs = parseTimeMs(job.scheduled_for);
    if (kinded === null || scheduledMs === null) {
      malformed += 1;
      continue;
    }
    if (isUnknownTag(kinded.tag)) {
      noteUnknownTag(unknown, kinded.tag);
    }
    if (!onDefaultWorker(kinded) || scheduledMs > nowMs) {
      continue;
    }
    count += 1;
    maxWaitMs = Math.max(maxWaitMs, nowMs - scheduledMs);
  }
  if (response.length > 0 && malformed === response.length) {
    return null;
  }
  return {
    count,
    unknownTags: unknownTagsOf(unknown),
    maxWaitSeconds: Math.floor(maxWaitMs / 1000),
    malformed,
  };
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

// ---------------------------------------------------------------------------
// 日次のまとめ
// ---------------------------------------------------------------------------

/** 1日に記録される行の数。2分ごとの記録がすべて残ったときの数で、欠けの割合の分母になる。 */
export const WORKER_SAMPLES_PER_DAY = (24 * 60) / SAMPLE_INTERVAL_MINUTES;

/** 日次のまとめで「遅れた記録」に数える`lag_seconds`の下限(秒)。 */
export const DAILY_LAG_THRESHOLD_SECONDS = 30;

/**
 * 日次のまとめで「空白」に数える、行の間隔の下限(秒)。
 * 期待する間隔(2分)の2倍を超えたとき、その間の記録が少なくとも1回は取れていない。
 * 正常な日の両端の間隔(始端から最初の行、最後の行から終端)は、これを超えない。
 */
export const DAILY_GAP_THRESHOLD_SECONDS = SAMPLE_INTERVAL_MINUTES * 2 * 60;

/**
 * 1日分の`factory.worker_samples`の集計。`null`は、その日のどの行にも値が無かったことを表す。
 * 0は、読めて0だったことを表す。
 */
export type WorkerLoadSummary = {
  /** 範囲内の行の数。 */
  readonly sample_count: number;
  /** 範囲で期待する行の数(`WORKER_SAMPLES_PER_DAY`)。 */
  readonly expected_count: number;
  /** `lag_seconds`の最大。 */
  readonly lag_max_seconds: number | null;
  /** `lag_seconds`が`DAILY_LAG_THRESHOLD_SECONDS`以上の行の数。 */
  readonly lag_over_count: number;
  /** `lag_seconds`が`DAILY_LAG_THRESHOLD_SECONDS`以上の行の`lag_seconds`の合計(秒)。 */
  readonly lag_over_total_seconds: number;
  /**
   * `sampled_at`の間隔が`DAILY_GAP_THRESHOLD_SECONDS`を超えた回数。
   * 隣り合う行の間隔に加えて、日の両端も数える。
   * 範囲の最初の行は、始端の10分前までの直近の行との間隔で、そこに行が無ければ始端との間隔で数える。
   * 最後の行は、終端との間隔で数える。
   */
  readonly gap_count: number;
  /** 数えた空白のうち最長の間隔(秒)。空白が無ければ`null`。 */
  readonly gap_longest_seconds: number | null;
  /** 最長の空白の開始の時刻。空白が無ければ`null`。 */
  readonly gap_longest_from: Date | null;
  /** 最長の空白の終了の時刻。空白が無ければ`null`。 */
  readonly gap_longest_to: Date | null;
  /** `running_jobs`の最大。記録のジョブ自身は含まない。 */
  readonly running_jobs_max: number | null;
  /** `slots`の最大。記録のジョブ自身が1つ使うので、他のジョブが使える上限は`slots - 1`である。 */
  readonly slots_max: number | null;
  /** `mem_anon_bytes`の最大(バイト)。 */
  readonly mem_anon_max_bytes: number | null;
  /** 行ごとの`mem_anon_bytes / mem_limit_bytes`の最大。上限が読めた行だけで求める。 */
  readonly mem_anon_max_ratio: number | null;
  /** `mem_working_set_bytes`の最大(バイト)。 */
  readonly mem_working_set_max_bytes: number | null;
  /**
   * `mem_oom`が値の読めた行の間で増えた回数の合計。
   * 累積が戻った(コンテナの再起動)ときは、現在値を増分として数える。
   * 増分を1つも求められないとき(値の読めた行が1行だけなど)は`null`。
   */
  readonly mem_oom_increase: number | null;
  /** `mem_oom_kill`の増分の合計。数え方と`null`の意味は`mem_oom_increase`と同じ。 */
  readonly mem_oom_kill_increase: number | null;
  /** `max_wait_seconds`の最大。記録のジョブ自身の遅れで打ち切られるので、下限である。 */
  readonly max_wait_max_seconds: number | null;
};

/**
 * 日次のまとめに載せる、集計の対象の日の負荷の読み取り結果。
 * 記録が無かったことと、集計を読めなかったことは、次の操作が違うので分ける。
 */
export type WorkerLoadReport =
  | { readonly kind: "summary"; readonly summary: WorkerLoadSummary }
  | { readonly kind: "no_record" }
  | { readonly kind: "read_failed" };

const BYTES_PER_MIB = 1024 * 1024;

function percent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

/** 欠けた記録があるのに、整数のパーセントでは0%に丸まるときだけ、小数1桁で出す。 */
function missingPercent(ratio: number): string {
  return ratio > 0 && Math.round(ratio * 100) === 0
    ? `${(ratio * 100).toFixed(1)}%`
    : percent(ratio);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `date`のJSTの時刻を`HH:MM`で返す。 */
function jstClock(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function mib(bytes: number): string {
  return `${String(Math.round(bytes / BYTES_PER_MIB))}MiB`;
}

function missingLine(summary: WorkerLoadSummary): string {
  const missing = Math.max(
    0,
    1 - summary.sample_count / summary.expected_count,
  );
  return `記録${String(summary.sample_count)}/${String(summary.expected_count)}件(欠け${missingPercent(missing)})`;
}

function lagLine(summary: WorkerLoadSummary): string {
  return summary.lag_max_seconds === null
    ? "遅れ: 不明"
    : `遅れ: 最大${String(summary.lag_max_seconds)}秒、${String(DAILY_LAG_THRESHOLD_SECONDS)}秒以上${String(summary.lag_over_count)}件(計${String(summary.lag_over_total_seconds)}秒)`;
}

function gapLine(summary: WorkerLoadSummary): string {
  const threshold = String(DAILY_GAP_THRESHOLD_SECONDS / 60);
  if (summary.gap_count === 0 || summary.gap_longest_seconds === null) {
    return `空白: ${threshold}分超なし`;
  }
  const minutes = String(Math.ceil(summary.gap_longest_seconds / 60));
  const when =
    summary.gap_longest_from === null || summary.gap_longest_to === null
      ? ""
      : `(${jstClock(summary.gap_longest_from)}〜${jstClock(summary.gap_longest_to)})`;
  return `空白: ${threshold}分超${String(summary.gap_count)}回、最長${minutes}分${when}`;
}

/**
 * 空白がある日だけ、読み方を添える。
 * 長い空白は、停止でも、長いジョブが枠を塞いだ場合でも出るので、
 * 形からは断定せず、その時刻のジョブの有無で見分けるよう促す。
 * 遅れだけの日は、ポーリングの山で毎日出るので添えない。
 */
function readingHint(summary: WorkerLoadSummary): string | null {
  return summary.gap_count > 0
    ? "読み方: 長い空白は、停止か、長いジョブによる枠の塞がり。その時刻にジョブが動いていたかで見分ける"
    : null;
}

function runningLine(summary: WorkerLoadSummary): string {
  return summary.running_jobs_max === null || summary.slots_max === null
    ? "他のジョブの枠の使用: 不明"
    : `他のジョブの枠の使用: 最大${String(summary.running_jobs_max)}件(記録の枠を除く、上限${String(summary.slots_max - 1)})`;
}

function countText(count: number | null): string {
  return count === null ? "不明" : `${String(count)}回`;
}

function oomText(summary: WorkerLoadSummary): string {
  const { mem_oom_increase: oom, mem_oom_kill_increase: kill } = summary;
  if ((oom ?? 0) > 0 || (kill ?? 0) > 0) {
    return `OOMあり(OOM ${countText(oom)}、kill ${countText(kill)})`;
  }
  return oom === null || kill === null ? "OOMの増分は不明" : "OOMなし";
}

function memoryLine(summary: WorkerLoadSummary): string {
  if (
    summary.mem_anon_max_bytes === null &&
    summary.mem_working_set_max_bytes === null
  ) {
    return `メモリ: 不明、${oomText(summary)}`;
  }
  const anon =
    summary.mem_anon_max_bytes === null
      ? "anon最大不明"
      : `anon最大${mib(summary.mem_anon_max_bytes)}${
          summary.mem_anon_max_ratio === null
            ? ""
            : `(上限の${percent(summary.mem_anon_max_ratio)})`
        }`;
  const workingSet =
    summary.mem_working_set_max_bytes === null
      ? "working set最大不明"
      : `working set最大${mib(summary.mem_working_set_max_bytes)}`;
  return `メモリ: ${anon}、${workingSet}、${oomText(summary)}`;
}

function waitLine(summary: WorkerLoadSummary): string {
  return summary.max_wait_max_seconds === null
    ? "待ちの最長: 不明"
    : `待ちの最長: ${String(summary.max_wait_max_seconds)}秒以上`;
}

/**
 * 1日分の集計を、日次のまとめのDiscordの欄に載せる複数行の文にする。
 * 見方は`docs/operations.md`の「日次のまとめでの見方」にある。
 */
export function summarizeWorkerLoad(summary: WorkerLoadSummary): string {
  return [
    missingLine(summary),
    lagLine(summary),
    gapLine(summary),
    readingHint(summary),
    runningLine(summary),
    memoryLine(summary),
    waitLine(summary),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** その日の負荷の読み取り結果を、Discordの欄の文にする。記録が無い場合と読めない場合は、次の操作を添える。 */
export function describeWorkerLoad(report: WorkerLoadReport): string {
  switch (report.kind) {
    case "summary":
      return summarizeWorkerLoad(report.summary);
    case "no_record":
      return "その日の記録なし(sample_worker_loadのスケジュールを確かめる)";
    case "read_failed":
      return "集計を読めませんでした(`wmill job list --script-path f/factory/notify_daily_summary`で直近のジョブを探し、ログの警告を確認)";
  }
}
