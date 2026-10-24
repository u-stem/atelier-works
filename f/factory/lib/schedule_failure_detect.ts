// scheduleのジョブの失敗を、Windmillのジョブ履歴から拾って記録し、通知する。
// scheduleの`on_failure`はこのWindmillでは呼ばれないので、失敗の入口はここだけである。
// 前回の続きの位置は、検出器自身の直近の成功した実行の結果(`processed_until`)に持つ。表も変数も足さない。
// 失敗した回は成功に数えないので、続きの位置が進まず、次の回が同じ範囲をやり直す。
// 検出器自身が止まったことは、`schedule_detector_heartbeat.ts`が、その成功した実行の完了時刻から見つける。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { JobIds } from "./job_ids.ts";
import { type Logger, maskSecrets } from "./log.ts";
import {
  flagFailingSchedule,
  type PreviousScheduleFailure,
} from "./schedule_failing.ts";
import { reportScheduleFailure } from "./schedule_failure_report.ts";
import {
  baselineRunsQuery,
  collectPages,
  describeJobError,
  extractScheduleFailures,
  failuresQuery,
  findBaselineRun,
  groupByScript,
  hasOtherScheduleJob,
  nextProcessedUntil,
  readProcessedUntil,
  SCAN_PAGE_SIZE,
  type ScheduleFailureJob,
  scanWindow,
  scriptHistoryQuery,
  VISIBILITY_RECENT_MS,
  VISIBILITY_WIDE_MS,
  visibilityQuery,
} from "./schedule_failure_scan.ts";
import type { FailureRecord, NoticeRecord } from "./types.ts";

/** 失敗1件の通知の内容。 */
export type JobFailedAnnouncement = {
  readonly flowPath: string;
  readonly jobId: string;
  readonly error: string;
};

export type ScheduleFailureDetectDeps = {
  readonly workspace: string;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  /** 完了したジョブの結果を返す。一覧の応答には結果が入らないことがある。 */
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  /** ジョブの詳細を返す。失敗したジョブのエラー文を読む。 */
  readonly getJob: (id: string) => Promise<unknown>;
  /** 渡したジョブIDのうち、スケジュールの失敗として記録済みのものを返す。 */
  readonly listRecordedJobIds: (
    jobIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** `flowPath`のスケジュールの失敗として、最後に記録された失敗を返す。無ければ`null`。 */
  readonly getLatestFailure: (
    flowPath: string,
  ) => Promise<PreviousScheduleFailure | null>;
  readonly recordFailure: (
    record: FailureRecord,
    jobIds: JobIds,
  ) => Promise<number>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** `job_failed`をDiscordに送る。 */
  readonly sendJobFailed: (failure: JobFailedAnnouncement) => Promise<void>;
  readonly log: Logger;
};

/** `main`の戻り値。次の回が`processed_until`を前回の続きの位置として読む。 */
export type ScheduleFailureDetectResult = {
  /** `bootstrap`は前回の成功が無く、基準だけを作った回。何も記録しない。 */
  readonly mode: "bootstrap" | "scan";
  readonly processed_until: string;
  /** 読んだ範囲で見つけた、新しい失敗の数。記録済みのものを含む。 */
  readonly found: number;
  /** 今回記録した数。 */
  readonly recorded: number;
  /** ページの上限で打ち切ったか。 */
  readonly truncated: boolean;
};

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 前回の続きの位置を読む。前回の成功した実行が無ければ`null`を返す。
 * 一覧が配列でないときは例外を投げる。基準を無かったことにして、拾えない範囲を作らないためである。
 */
async function readBaseline(
  deps: ScheduleFailureDetectDeps,
): Promise<number | null> {
  const response = await deps.listCompletedJobs(
    baselineRunsQuery(deps.workspace),
  );
  if (!Array.isArray(response)) {
    throw new Error("the response for the previous run is not a list");
  }
  const run = findBaselineRun(response);
  if (run === null) {
    return null;
  }
  return readProcessedUntil(await deps.getCompletedJobResult(run.id), run);
}

/**
 * 他のscheduleのジョブが見えていることを確かめる。
 * 権限が足りないと一覧は黙って空になり、失敗が無いことと区別できないためである。
 * 直近の範囲で見えなくても、広い範囲で見えれば、スリープ明けなどとして警告だけにする。
 */
async function verifyVisibility(
  deps: ScheduleFailureDetectDeps,
  nowMs: number,
): Promise<void> {
  const recent = await deps.listCompletedJobs(
    visibilityQuery(deps.workspace, nowMs - VISIBILITY_RECENT_MS),
  );
  if (hasOtherScheduleJob(recent)) {
    return;
  }
  deps.log.warn("no job of another schedule started in the last 15 minutes");
  const wide = await deps.listCompletedJobs(
    visibilityQuery(deps.workspace, nowMs - VISIBILITY_WIDE_MS),
  );
  if (!hasOtherScheduleJob(wide)) {
    throw new Error(
      "no job of another schedule is visible in the last 24 hours; the job list may be hidden by missing permissions",
    );
  }
}

/** 失敗したジョブのエラー文を読む。読めなければ、読めなかった旨の固定の文にする。 */
async function readErrorText(
  deps: ScheduleFailureDetectDeps,
  failure: ScheduleFailureJob,
): Promise<string> {
  try {
    return describeJobError(await deps.getJob(failure.id));
  } catch (err) {
    deps.log.warn("could not read the error of a failed job", {
      job_id: failure.id,
      error: errorText(err),
    });
    return describeJobError(
      failure.canceledByTimeout
        ? { canceled: true, canceled_by: "timeout" }
        : null,
    );
  }
}

type ScriptOutcome = {
  readonly recorded: number;
  readonly recordFailed: number;
};

/**
 * 1つのscriptの新しい失敗(古い順)を記録し、通知する。
 * 前回の失敗は記録の前に1回だけ読む。束の2件目以降の前回は、束の直前の件とする。
 * `job_failed`の判定は束の全件に当て、1件でも該当すれば、最新の失敗の内容で1回だけ送る。
 * 3回連続の失敗の判定は、最後に1回だけ行う。
 */
async function processScript(
  deps: ScheduleFailureDetectDeps,
  scriptPath: string,
  failures: readonly ScheduleFailureJob[],
  recordedIds: ReadonlySet<string>,
): Promise<ScriptOutcome> {
  let previous: PreviousScheduleFailure | null = null;
  try {
    previous = await deps.getLatestFailure(scriptPath);
  } catch (err) {
    // 読めなければ、変わったかを判定できないので、通知を送る側に倒す。
    deps.log.error("failed to read the previous failure", {
      flow_path: scriptPath,
      error: errorText(err),
    });
  }

  // 履歴は、通知の判定と連続した失敗の判定で使い回す。
  let runsRequest: Promise<unknown> | undefined;
  const fetchRuns = (): Promise<unknown> => {
    runsRequest ??= deps.listCompletedJobs(
      scriptHistoryQuery(deps.workspace, scriptPath),
    );
    return runsRequest;
  };
  let runs: unknown = null;
  try {
    runs = await fetchRuns();
  } catch (err) {
    // 履歴を読めなければ、初回の失敗として通知する。
    deps.log.error("failed to read the schedule history for the notification", {
      flow_path: scriptPath,
      error: errorText(err),
    });
  }

  let chain = previous;
  let notify = false;
  let latest: JobFailedAnnouncement | null = null;
  let recorded = 0;
  let recordFailed = 0;
  for (const failure of failures) {
    const error = await readErrorText(deps, failure);
    const report = await reportScheduleFailure(
      {
        flowPath: scriptPath,
        jobId: failure.id,
        error,
        occurredAt: failure.completedAt,
        runs,
        previousFailure: chain,
      },
      {
        isRecorded: (jobId) => recordedIds.has(jobId),
        recordFailure: deps.recordFailure,
        log: deps.log,
      },
    );
    chain = { job_id: failure.id, error };
    if (report.status === "record_failed") {
      recordFailed += 1;
      continue;
    }
    if (report.status === "recorded") {
      recorded += 1;
      latest = { flowPath: scriptPath, jobId: failure.id, error };
    }
    notify = notify || report.notify;
  }

  let announced = false;
  if (notify && latest !== null) {
    try {
      await deps.sendJobFailed(latest);
      announced = true;
    } catch (err) {
      deps.log.error("failed to send discord notification", {
        flow_path: scriptPath,
        error: errorText(err),
      });
    }
  }

  // 直近の実行が続けて失敗しているscriptは、Discordの通知を見落としても拾えるよう、noticeにも残す。
  // 初回の通知が届かなかった場合に備え、noticeを新しく残したときは、まだ送っていなければDiscordにも送る。
  const lastRecorded = latest;
  await flagFailingSchedule(scriptPath, {
    listRecentRuns: () => fetchRuns(),
    addNotice: (record) => deps.addNotice(record),
    onFailingNoticeInserted: async () => {
      if (!announced && lastRecorded !== null) {
        await deps.sendJobFailed(lastRecorded);
      }
    },
    log: deps.log,
  });
  return { recorded, recordFailed };
}

/**
 * 前回の続きの位置から、失敗したscheduleのジョブを拾って記録し、通知する。
 * 前回の成功した実行が無い(初回)ときは、何も記録せず、続きの位置だけを作って成功で終える。
 * 過去の失敗をさかのぼって通知しないためである。
 * 次の場合は例外を投げる。成功に数えないので、続きの位置は進まず、検出器の心拍が止まる。
 * - 一覧を読めない。
 * - 他のscheduleのジョブが見えない(権限不足の疑い)。
 * - ページの上限に達し、かつ続きの位置を進められない。
 * - 失敗の記録に1件でも失敗した(残りの処理は続けてから投げる)。
 */
export async function detectScheduleFailures(
  deps: ScheduleFailureDetectDeps,
): Promise<ScheduleFailureDetectResult> {
  const startedAtMs = deps.now();
  const baselineMs = await readBaseline(deps);
  await verifyVisibility(deps, startedAtMs);
  if (baselineMs === null) {
    deps.log.info("no previous run; made the baseline only");
    return {
      mode: "bootstrap",
      processed_until: new Date(startedAtMs).toISOString(),
      found: 0,
      recorded: 0,
      truncated: false,
    };
  }

  const window = scanWindow(baselineMs, startedAtMs);
  if (window.clamped) {
    deps.log.warn(
      "the last scan is older than the maximum window; scanning the last day only",
      { baseline: new Date(baselineMs).toISOString() },
    );
  }
  const { jobs, truncated } = await collectPages((page) =>
    deps.listCompletedJobs(
      failuresQuery(deps.workspace, window.startedAfterMs, page),
    ),
  );
  const { failures, malformed } = extractScheduleFailures(
    jobs,
    window.baselineMs,
  );
  if (malformed > 0) {
    deps.log.warn("the failure list has elements that could not be read", {
      count: malformed,
    });
  }
  const processedUntilMs = nextProcessedUntil({
    failures,
    baselineMs: window.baselineMs,
    runStartedAtMs: startedAtMs,
    truncated,
  });
  if (truncated) {
    deps.log.warn("the failure list reached the page limit", {
      pages: Math.ceil(jobs.length / SCAN_PAGE_SIZE),
    });
    if (processedUntilMs <= window.baselineMs) {
      throw new Error(
        "the failure list reached the page limit with no progress: it holds no failure newer than the baseline",
      );
    }
  }

  const recordedIds = await deps.listRecordedJobIds(
    failures.map((failure) => failure.id),
  );
  const fresh = failures.filter((failure) => !recordedIds.has(failure.id));
  let recorded = 0;
  let recordFailed = 0;
  for (const [scriptPath, group] of groupByScript(fresh)) {
    const outcome = await processScript(deps, scriptPath, group, recordedIds);
    recorded += outcome.recorded;
    recordFailed += outcome.recordFailed;
  }
  if (recordFailed > 0) {
    throw new Error(
      `failed to record ${String(recordFailed)} schedule failure(s)`,
    );
  }
  const result: ScheduleFailureDetectResult = {
    mode: "scan",
    processed_until: new Date(processedUntilMs).toISOString(),
    found: failures.length,
    recorded,
    truncated,
  };
  deps.log.info("schedule failures scanned", result);
  return result;
}
