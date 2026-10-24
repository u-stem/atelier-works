// scheduleが起こしたジョブの失敗を、Windmillのジョブ履歴から拾うための純粋な部品。
// 一覧の問い合わせの組み立て、応答の読み取り、窓の計算を持つ。入出力は`schedule_failure_detect.ts`が行う。
// 応答は信頼できない入力として読み、形の違う要素は数えて捨てる。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import { maskSecrets } from "./log.ts";
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
 * 全件を読み終えたとき、続きの位置を実行の開始よりこの時間だけ手前に置く。
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

/** 取り消しの`canceled_by`がこの値のとき、時間切れによる取り消しとみなす。 */
const TIMEOUT_CANCELED_BY = "timeout";

/** 検出器が拾った、scheduleが起こしたジョブの失敗。 */
export type ScheduleFailureJob = {
  readonly id: string;
  /** 失敗したscriptまたはflowのpath。`schedule_failing`の履歴と同じ値である。 */
  readonly scriptPath: string;
  readonly completedAtMs: number;
  /** 一覧が返した完了時刻の文字列。記録の発生時刻に使う。 */
  readonly completedAt: string;
  readonly canceledByTimeout: boolean;
};

/** 検出器自身の、前回の成功した実行。 */
export type BaselineRun = {
  readonly id: string;
  readonly startedAtMs: number;
  /** 完了時刻。応答に無い、または読めないときは`null`。 */
  readonly completedAtMs: number | null;
};

/** 読む範囲。 */
export type ScanWindow = {
  /** 続きの位置。次の回の`processed_until`の下限になる。 */
  readonly baselineMs: number;
  /** 一覧に頼む開始時刻の下限。 */
  readonly startedAfterMs: number;
  /** 完了時刻がこれ以降のジョブを新しい失敗とする。打ち切った回の続きでは0で、完了時刻では絞らない。 */
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
      const completedAtMs = isString(run.completed_at)
        ? Date.parse(run.completed_at)
        : Number.NaN;
      return {
        id: run.id,
        startedAtMs,
        completedAtMs: Number.isNaN(completedAtMs) ? null : completedAtMs,
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
 * `scanStartedAfterMs`は、前回がページの上限で打ち切られたときの、読んだ最後の開始時刻である。
 * 渡されたときは、その値をそのまま開始時刻の下限にする(遡りを引かない)。完了時刻では絞らず、重なりは記録済みの除外で吸収する。
 * 完了時刻で絞ると、開始が遅く完了が早い未読の失敗を落とすためである。
 * 古すぎるときは、`SCAN_MAX_WINDOW_MS`前を下限にするので、止まった検出器の続きが必ず24時間で抜ける。
 */
export function scanWindow(
  baselineMs: number,
  nowMs: number,
  scanStartedAfterMs: number | null = null,
): ScanWindow {
  const bounded = Math.min(baselineMs, nowMs);
  const floor = nowMs - SCAN_MAX_WINDOW_MS;
  const baseline = Math.max(bounded, floor);
  if (scanStartedAfterMs !== null) {
    return {
      baselineMs: baseline,
      startedAfterMs: Math.max(Math.min(scanStartedAfterMs, nowMs), floor),
      completedFromMs: 0,
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
 * 形の違う要素は`malformed`に数える。
 */
export function extractScheduleFailures(
  jobs: readonly unknown[],
  baselineMs: number,
): { failures: ScheduleFailureJob[]; malformed: number } {
  const failures: ScheduleFailureJob[] = [];
  let malformed = 0;
  for (const job of jobs) {
    if (!isRecord(job)) {
      malformed += 1;
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
    if (
      !isString(job.id) ||
      !isString(job.script_path) ||
      !isString(job.completed_at)
    ) {
      malformed += 1;
      continue;
    }
    const completedAtMs = Date.parse(job.completed_at);
    if (Number.isNaN(completedAtMs)) {
      malformed += 1;
      continue;
    }
    if (completedAtMs < baselineMs) {
      continue;
    }
    failures.push({
      id: job.id,
      scriptPath: job.script_path,
      completedAtMs,
      completedAt: job.completed_at,
      canceledByTimeout,
    });
  }
  failures.sort(
    (a, b) =>
      a.completedAtMs - b.completedAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { failures, malformed };
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

/** 他のscheduleのジョブが見えているかを確かめる、`sinceMs`以降に開始した根のジョブの問い合わせ。 */
export function visibilityQuery(
  workspace: string,
  sinceMs: number,
): ListCompletedJobsData {
  return {
    workspace,
    hasNullParent: true,
    scriptPathStart: SCAN_SCRIPT_PATH_PREFIX,
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
 * 秘密情報をマスクし、制御文字を落とし、`ERROR_MAX_CHARS`文字に切る。
 */
export function describeJobError(job: unknown): string {
  return truncate(stripControlCharacters(maskSecrets(rawJobError(job))));
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
 * 一覧の要素のうち、最も遅い開始時刻をエポックミリ秒で返す。読める開始時刻が無ければ`null`を返す。
 * 失敗の絞り込みで落とす要素も数える。落とした要素だけで1ページが埋まっても、位置が進むようにするためである。
 * 並び順に頼らないよう、最後の要素ではなく最大を取る。
 */
export function latestStartedAtMs(jobs: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const job of jobs) {
    if (!isRecord(job) || !isString(job.started_at)) {
      continue;
    }
    const ms = Date.parse(job.started_at);
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
  if (isRecord(result) && isString(result.scan_started_after)) {
    const ms = Date.parse(result.scan_started_after);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return null;
}

/**
 * 次の回の`processed_until`を返す。
 * 全件を読み終えたときは、この回の開始から`SCAN_OVERLAP_MS`手前(`baselineMs`より戻さない)にする。
 * 最後の失敗の完了時刻に留めると、その後に失敗が無い間、位置が進まず、同じ範囲を読み直し続けるためである。
 * ページの上限で打ち切ったときは、`baselineMs`のままにする。続きは`scan_started_after`(開始時刻)で読むので、
 * 完了時刻の位置は使わない。
 */
export function nextProcessedUntil(input: {
  readonly baselineMs: number;
  readonly runStartedAtMs: number;
  readonly truncated: boolean;
}): number {
  if (input.truncated) {
    return input.baselineMs;
  }
  return Math.max(input.baselineMs, input.runStartedAtMs - SCAN_OVERLAP_MS);
}
