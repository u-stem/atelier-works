// scheduleが起こしたジョブの失敗を、Windmillのジョブ履歴から拾うための純粋な部品。
// 一覧の問い合わせの組み立て、応答の読み取り、窓の計算を持つ。入出力は`schedule_failure_detect.ts`が行う。
// 応答は信頼できない入力として読み、形の違う要素は数えて捨てる。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import { maskSecrets } from "./log.ts";
import { PERIODIC_WORKER_TAG } from "./periodic_worker.ts";
import { SCHEDULE_FAILING_FETCH_COUNT } from "./schedule_failing.ts";
import { isRecord, isString } from "./types.ts";

/**
 * 失敗を拾うscript。scheduleのpathもこの値と同じにする。
 * 自分の成功した実行を探すときの絞り込みと、見えているジョブから自分を除くときに使う。
 */
export const SCHEDULE_DETECTOR_PATH = "f/factory/detect_schedule_failures";

/** 拾う対象のscriptのpathの先頭。Factory以外の個人のscheduleは拾わない。 */
const SCAN_SCRIPT_PATH_PREFIX = "f/factory/";

/**
 * 前回の続きの位置から、さらにこの時間さかのぼって、開始したジョブを一覧する。
 * 一覧には完了時刻の絞り込みが無く、開始時刻でしか絞れない。続きの位置より前に開始して後に失敗したジョブを
 * 取りこぼさないよう、動きうる最長の時間より長くする。
 * timeoutを持たないscriptの上限は、インスタンスの`job_default_timeout`(21600秒)である。
 */
export const SCAN_LOOKBACK_MS = 7 * 60 * 60 * 1000;

/** 続きの位置が現在よりこれ以上古いときは、この時間前から読む。検出器が長く止まった後に、古い失敗を束で届けないため。 */
export const SCAN_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 1ページの件数。APIの上限である。 */
export const SCAN_PAGE_SIZE = 100;

/** 1回の実行で読むページの上限。 */
export const SCAN_MAX_PAGES = 5;

/**
 * 通常の回(読み終えた回も、ページの上限で打ち切った回も)の`processed_until`を、実行の開始よりこの時間だけ手前に置く。
 * ジョブの完了時刻の記録と一覧への表示のずれで、取りこぼさないためである。
 * 重なった分は、記録済みのジョブとして飛ばす。
 */
export const SCAN_OVERLAP_MS = 60 * 1000;

/** 他のscheduleのジョブが見えているかを、まず確かめる範囲。 */
export const VISIBILITY_RECENT_MS = 15 * 60 * 1000;

/** 直近の範囲で見えなかったとき、続けて確かめる範囲。 */
export const VISIBILITY_WIDE_MS = 24 * 60 * 60 * 1000;

/** 自己確認で一覧に頼む件数。検出器自身のジョブを除いても残るよう、数件より多く取る。 */
const VISIBILITY_PER_PAGE = 20;

/** 検出器自身の成功した実行を探すときに一覧に頼む件数。 */
const BASELINE_PER_PAGE = 10;

/** 記録するエラー文の最大の文字数。 */
export const ERROR_MAX_CHARS = 2000;

const UNREADABLE_ERROR = "the job failed without a readable error";

/** 読めなかった要素の記録に載せる最大の件数。 */
const MALFORMED_SAMPLE_MAX = 5;

/** 取り消しの`canceled_by`がこの値のとき、時間切れによる取り消しとみなす。 */
const TIMEOUT_CANCELED_BY = "timeout";

/** 読めなかった要素の記録。IDと、欠けている項目の名前だけで、値は含めない。 */
export type MalformedSample = {
  readonly id: string | null;
  readonly missing: readonly string[];
};

/** 検出器が拾った、scheduleが起こしたジョブの失敗。 */
export type ScheduleFailureJob = {
  readonly id: string;
  /** 失敗したscriptまたはflowのpath。`schedule_failing`の履歴と同じ値である。 */
  readonly scriptPath: string;
  readonly completedAtMs: number;
  /** 完了時刻のISO文字列。記録の発生時刻に使う。 */
  readonly completedAt: string;
  readonly canceledByTimeout: boolean;
};

/** 検出器自身の、前回の成功した実行。 */
export type BaselineRun = {
  readonly id: string;
  readonly startedAtMs: number;
  /** 完了時刻。開始時刻と所要時間から求める。求められないときは`null`。 */
  readonly completedAtMs: number | null;
};

/** 読む範囲。 */
export type ScanWindow = {
  /** 続きの位置。次の回の`processed_until`の下限になる。 */
  readonly baselineMs: number;
  /** 一覧に頼む開始時刻の下限。 */
  readonly startedAfterMs: number;
  /** 完了時刻がこれ以降のジョブを新しい失敗とする。打ち切った回の続きでは、打ち切った最初の回の基準(`scan_completed_from`)を引き継ぐ。 */
  readonly completedFromMs: number;
  /** 続きの位置が古すぎて、`SCAN_MAX_WINDOW_MS`に切り詰めたか。 */
  readonly clamped: boolean;
};

/** 検出器自身の、成功した実行を新しい順に頼む問い合わせ。 */
export function baselineRunsQuery(workspace: string): ListCompletedJobsData {
  return {
    workspace,
    schedulePath: SCHEDULE_DETECTOR_PATH,
    scriptPathExact: SCHEDULE_DETECTOR_PATH,
    success: true,
    isSkipped: false,
    orderDesc: true,
    perPage: BASELINE_PER_PAGE,
  };
}

/**
 * 一覧の要素の完了時刻を返す。求められなければ`null`を返す。
 * 実機の一覧の要素には`completed_at`が無く、`created_at`、`started_at`、`duration_ms`(ミリ秒の数値)がある。
 * そのため完了時刻は、`started_at`に`duration_ms`を足して求める。
 * `completed_at`があれば、それを使う。
 */
function completionOf(
  job: Record<string, unknown>,
): { readonly ms: number; readonly iso: string } | null {
  if (isString(job.completed_at)) {
    const ms = Date.parse(job.completed_at);
    if (!Number.isNaN(ms)) {
      return { ms, iso: job.completed_at };
    }
  }
  if (isString(job.started_at) && isFiniteNumber(job.duration_ms)) {
    const startedAtMs = Date.parse(job.started_at);
    if (!Number.isNaN(startedAtMs)) {
      const ms = startedAtMs + job.duration_ms;
      return { ms, iso: new Date(ms).toISOString() };
    }
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 完了時刻を求められない要素について、欠けている、または読めない項目の名前を返す。値は含めない。 */
function missingForCompletion(job: Record<string, unknown>): string[] {
  const missing = ["completed_at"];
  if (!isString(job.started_at) || Number.isNaN(Date.parse(job.started_at))) {
    missing.push("started_at");
  }
  if (!isFiniteNumber(job.duration_ms)) {
    missing.push("duration_ms");
  }
  return missing;
}

/**
 * 一覧の応答(新しい順)から、検出器のscheduleが起こした成功した実行の先頭を返す。無ければ`null`を返す。
 * サーバーが絞り込みを無視しても、手動の実行やpreview、飛ばされた実行を数えないよう、クライアントでも確かめる。
 * 飛ばされた実行は、`success`の値が実機で未確認なので、成功に数えない。
 */
export function findBaselineRun(response: unknown): BaselineRun | null {
  if (!Array.isArray(response)) {
    return null;
  }
  for (const run of response) {
    if (
      !isRecord(run) ||
      run.success !== true ||
      run.is_skipped === true ||
      run.schedule_path !== SCHEDULE_DETECTOR_PATH ||
      !isString(run.id) ||
      !isString(run.started_at)
    ) {
      continue;
    }
    const startedAtMs = Date.parse(run.started_at);
    if (!Number.isNaN(startedAtMs)) {
      return {
        id: run.id,
        startedAtMs,
        completedAtMs: completionOf(run)?.ms ?? null,
      };
    }
  }
  return null;
}

/**
 * 前回の実行の結果から、処理を終えた位置(`processed_until`)を読む。
 * 読めないときは、その実行の開始時刻を返す。
 */
export function readProcessedUntil(result: unknown, run: BaselineRun): number {
  if (isRecord(result) && isString(result.processed_until)) {
    const ms = Date.parse(result.processed_until);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return run.startedAtMs;
}

/**
 * 前回の続きの位置から、今回読む範囲を決める。
 * 続きの位置が未来(時計のずれ)なら現在とし、`SCAN_MAX_WINDOW_MS`より古ければその時間前に切り詰める。
 * `scanStartedAfterMs`は、前回がページの上限で打ち切られたときの、次の回の開始時刻の下限である。
 * 渡されたときは、その値をそのまま開始時刻の下限にする(遡りを引かない)。重なりは記録済みの除外で吸収する。
 * 完了時刻の下限は、打ち切った最初の回が使った基準(`scanCompletedFromMs`)を引き継ぐ。
 * 0にすると、基準を作った直後に打ち切られたとき、過去の失敗をさかのぼって記録する。
 * 渡されないときは`baselineMs`を使う。
 * 古すぎるときは、`SCAN_MAX_WINDOW_MS`前を下限にするので、止まった検出器の続きが必ず24時間で抜ける。
 */
export function scanWindow(
  baselineMs: number,
  nowMs: number,
  scanStartedAfterMs: number | null = null,
  scanCompletedFromMs: number | null = null,
): ScanWindow {
  const bounded = Math.min(baselineMs, nowMs);
  const floor = nowMs - SCAN_MAX_WINDOW_MS;
  const baseline = Math.max(bounded, floor);
  if (scanStartedAfterMs !== null) {
    return {
      baselineMs: baseline,
      startedAfterMs: Math.max(Math.min(scanStartedAfterMs, nowMs), floor),
      completedFromMs: Math.max(
        Math.min(scanCompletedFromMs ?? baseline, nowMs),
        floor,
      ),
      clamped: scanStartedAfterMs < floor,
    };
  }
  return {
    baselineMs: baseline,
    startedAfterMs: baseline - SCAN_LOOKBACK_MS,
    completedFromMs: baseline,
    clamped: bounded < floor,
  };
}

/**
 * 失敗した根のジョブを、開始の古い順に`page`ページ目から頼む問い合わせ。
 * 人が取り消した実行はクライアントで除くので、取り消しの絞り込みは付けない。
 */
export function failuresQuery(
  workspace: string,
  startedAfterMs: number,
  page: number,
): ListCompletedJobsData {
  return {
    workspace,
    success: false,
    hasNullParent: true,
    isSkipped: false,
    scriptPathStart: SCAN_SCRIPT_PATH_PREFIX,
    orderDesc: false,
    startedAfter: new Date(startedAfterMs).toISOString(),
    perPage: SCAN_PAGE_SIZE,
    page,
  };
}

/**
 * 一覧の応答から、`baselineMs`以降に完了した、scheduleが起こしたジョブの失敗を取り出す。
 * 結果は完了の古い順で、同じ時刻はIDの順である。
 * 除くもの: scheduleが起こしていない実行、飛ばされた実行、人が取り消した実行、失敗でない実行、
 * `baselineMs`より前に完了した実行。時間切れによる取り消し(`canceled_by`が`timeout`)は失敗に数える。
 * 完了時刻が`baselineMs`と同じ実行は残す。重なりは記録済みのジョブとして飛ばす。
 * 完了時刻は`completionOf`で求める。
 * 形の違う要素は`malformed`に数え、最初の数件は、IDと欠けている項目の名前を`malformedSamples`に残す(値は残さない)。
 */
export function extractScheduleFailures(
  jobs: readonly unknown[],
  baselineMs: number,
): {
  failures: ScheduleFailureJob[];
  malformed: number;
  malformedSamples: MalformedSample[];
} {
  const failures: ScheduleFailureJob[] = [];
  // ページのずれで、同じジョブが2回出ることがある。
  const seen = new Set<string>();
  let malformed = 0;
  const malformedSamples: MalformedSample[] = [];
  const reject = (id: string | null, missing: string[]): void => {
    malformed += 1;
    if (malformedSamples.length < MALFORMED_SAMPLE_MAX) {
      malformedSamples.push({ id, missing });
    }
  };
  for (const job of jobs) {
    if (!isRecord(job)) {
      reject(null, ["object"]);
      continue;
    }
    if (!isString(job.schedule_path) || job.schedule_path.length === 0) {
      continue;
    }
    if (job.is_skipped === true || job.success !== false) {
      continue;
    }
    const canceledByTimeout =
      job.canceled === true && job.canceled_by === TIMEOUT_CANCELED_BY;
    if (job.canceled === true && !canceledByTimeout) {
      continue;
    }
    const completion = completionOf(job);
    if (
      !isString(job.id) ||
      !isString(job.script_path) ||
      completion === null
    ) {
      const missing: string[] = [];
      if (!isString(job.id)) missing.push("id");
      if (!isString(job.script_path)) missing.push("script_path");
      if (completion === null) missing.push(...missingForCompletion(job));
      reject(isString(job.id) ? job.id : null, missing);
      continue;
    }
    if (completion.ms < baselineMs || seen.has(job.id)) {
      continue;
    }
    seen.add(job.id);
    failures.push({
      id: job.id,
      scriptPath: job.script_path,
      completedAtMs: completion.ms,
      completedAt: completion.iso,
      canceledByTimeout,
    });
  }
  failures.sort(
    (a, b) =>
      a.completedAtMs - b.completedAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { failures, malformed, malformedSamples };
}

/** 失敗をscriptごとにまとめる。まとまりの順は最初に現れた順で、まとまりの中は渡された順である。 */
export function groupByScript(
  failures: readonly ScheduleFailureJob[],
): Map<string, ScheduleFailureJob[]> {
  const groups = new Map<string, ScheduleFailureJob[]>();
  for (const failure of failures) {
    const group = groups.get(failure.scriptPath);
    if (group === undefined) {
      groups.set(failure.scriptPath, [failure]);
    } else {
      group.push(failure);
    }
  }
  return groups;
}

/**
 * 他のscheduleのジョブが見えているかを確かめる、`sinceMs`以降に開始した根のジョブの問い合わせ。
 * tagを定期ジョブ用のworkerのものに絞る。絞らないと、新しい20件が`console_query`などのscheduleの無いジョブで埋まり、
 * scheduleのジョブが見えないと誤って判定するためである。
 */
export function visibilityQuery(
  workspace: string,
  sinceMs: number,
): ListCompletedJobsData {
  return {
    workspace,
    hasNullParent: true,
    scriptPathStart: SCAN_SCRIPT_PATH_PREFIX,
    tag: PERIODIC_WORKER_TAG,
    startedAfter: new Date(sinceMs).toISOString(),
    orderDesc: true,
    perPage: VISIBILITY_PER_PAGE,
  };
}

/**
 * 一覧の応答に、検出器以外のscheduleが起こしたジョブが1件でもあるか。
 * 権限が足りないと一覧は黙って空になる。空のままでは何も失敗していないことと区別できないので、
 * 見えていることを毎回確かめる。
 */
export function hasOtherScheduleJob(response: unknown): boolean {
  return (
    Array.isArray(response) &&
    response.some(
      (job) =>
        isRecord(job) &&
        isString(job.schedule_path) &&
        job.schedule_path.length > 0 &&
        job.script_path !== SCHEDULE_DETECTOR_PATH,
    )
  );
}

/** `scriptPath`の直近の実行を新しい順に頼む問い合わせ。飛ばされた実行は除く。 */
export function scriptHistoryQuery(
  workspace: string,
  scriptPath: string,
): ListCompletedJobsData {
  return {
    workspace,
    scriptPathExact: scriptPath,
    orderDesc: true,
    isSkipped: false,
    perPage: SCHEDULE_FAILING_FETCH_COUNT,
  };
}

function stringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** ジョブの結果から失敗の文を取り出す。読み取れる文が無ければ`null`を返す。 */
function errorFromResult(result: unknown): string | null {
  if (isString(result)) {
    return result.length > 0 ? result : null;
  }
  if (!isRecord(result)) {
    return result === undefined || result === null ? null : stringify(result);
  }
  const error = result.error;
  if (isString(error)) {
    return error.length > 0 ? error : null;
  }
  if (isRecord(error) && isString(error.message) && error.message.length > 0) {
    return isString(error.name) && error.name.length > 0
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  return stringify(error === undefined ? result : error);
}

/** 制御文字を落とす。改行と復帰とタブは残す。NULは、textの列に入らず、記録が毎回失敗するためである。 */
function stripControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control || code === 0x09 || code === 0x0a || code === 0x0d) {
      out += char;
    }
  }
  return out;
}

function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length <= ERROR_MAX_CHARS
    ? text
    : chars.slice(0, ERROR_MAX_CHARS).join("");
}

/**
 * 失敗したジョブ(`JobService.getJob`の応答)から、記録するエラー文を作る。
 * 結果のエラー、取り消しの理由、時間切れの順に読み、どれも無ければ読めなかったことを示す固定の文にする。
 * 制御文字を落とし、秘密情報をマスクし、`ERROR_MAX_CHARS`文字に切る。この順にする。
 * 秘密情報の途中に制御文字があると、先にマスクしても一致せずに外れるためである。
 */
export function describeJobError(job: unknown): string {
  return truncate(maskSecrets(stripControlCharacters(rawJobError(job))));
}

function rawJobError(job: unknown): string {
  if (!isRecord(job)) {
    return UNREADABLE_ERROR;
  }
  const fromResult = errorFromResult(job.result);
  if (fromResult !== null) {
    return fromResult;
  }
  if (job.canceled === true) {
    const reason =
      isString(job.canceled_reason) && job.canceled_reason.length > 0
        ? job.canceled_reason
        : null;
    if (job.canceled_by === TIMEOUT_CANCELED_BY) {
      return reason === null
        ? "canceled by timeout"
        : `canceled by timeout: ${reason}`;
    }
    if (reason !== null) {
      return `canceled: ${reason}`;
    }
  }
  return UNREADABLE_ERROR;
}

/**
 * 1ページずつ`listPage`で読み、`SCAN_MAX_PAGES`ページまたは満たないページで止める。
 * 最後に読んだページが満ちたまま上限に達したときは、読み残しがあるとして`truncated`を`true`にする。
 * ページが一覧でなければ例外を投げる。
 */
export async function collectPages(
  listPage: (page: number) => Promise<unknown>,
): Promise<{ jobs: unknown[]; truncated: boolean }> {
  const jobs: unknown[] = [];
  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const response = await listPage(page);
    if (!Array.isArray(response)) {
      throw new Error(`the response of page ${String(page)} is not a list`);
    }
    jobs.push(...response);
    if (response.length < SCAN_PAGE_SIZE) {
      return { jobs, truncated: false };
    }
  }
  return { jobs, truncated: true };
}

/**
 * 一覧の要素のうち、最も遅い作成時刻をエポックミリ秒で返す。作成時刻が無い要素は開始時刻で数える。
 * 読める時刻が無ければ`null`を返す。
 * 次の回は、この値を開始時刻の下限にそのまま使う(`scan_started_after`)。
 * 一覧の並び順のキーが開始時刻か作成時刻かは実機で未確認なので、どちらでも安全な作成時刻を取る。
 * 読んでいないジョブの開始時刻は、作成時刻以降であり、並びのキーで読んだ分より後になる。
 * 失敗の絞り込みで落とす要素も数える。落とした要素だけで1ページが埋まっても、位置が進むようにするためである。
 * 並び順に頼らないよう、最後の要素ではなく最大を取る。
 */
export function latestScanPointMs(jobs: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const job of jobs) {
    if (!isRecord(job)) {
      continue;
    }
    const raw = isString(job.created_at) ? job.created_at : job.started_at;
    if (!isString(raw)) {
      continue;
    }
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) {
      latest = ms;
    }
  }
  return latest;
}

/**
 * 前回の実行の結果から、ページの上限で打ち切った回の続きの位置(`scan_started_after`)を読む。
 * 無い、または日時として読めないときは`null`を返す。
 */
export function readScanStartedAfter(result: unknown): number | null {
  return readTime(result, "scan_started_after");
}

/**
 * 次の回の`processed_until`を返す。
 * 通常の回は、読み終えたか打ち切ったかによらず(打ち切りは入力に要らない)、この回の開始から`SCAN_OVERLAP_MS`手前(`baselineMs`より戻さない)にする。
 * 最後の失敗の完了時刻に留めると、その後に失敗が無い間、位置が進まず、同じ範囲を読み直し続けるためである。
 * 打ち切った回の時点で実行中だったジョブの失敗は、続きの回が読む開始時刻の下限より前に開始している。
 * その失敗は、続きを読み終えた後の通常の回が、この位置と遡りで読み直して拾う。
 * 続きの回(`continued`)は、位置を進めずに`baselineMs`のまま返す。進めると、その失敗が下限の外に出るためである。
 */
export function nextProcessedUntil(input: {
  readonly baselineMs: number;
  readonly runStartedAtMs: number;
  readonly continued: boolean;
}): number {
  if (input.continued) {
    return input.baselineMs;
  }
  return Math.max(input.baselineMs, input.runStartedAtMs - SCAN_OVERLAP_MS);
}

function readTime(result: unknown, key: string): number | null {
  if (isRecord(result)) {
    const value = result[key];
    if (isString(value)) {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) {
        return ms;
      }
    }
  }
  return null;
}

/**
 * 前回の実行の結果から、打ち切った回の続きの完了時刻の下限(`scan_completed_from`)を読む。
 * 打ち切った最初の回が使った基準である。無い、または日時として読めないときは`null`を返す。
 */
export function readScanCompletedFrom(result: unknown): number | null {
  return readTime(result, "scan_completed_from");
}
