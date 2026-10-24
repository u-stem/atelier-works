// scheduleの失敗を拾う検出器(`detect_schedule_failures`)が止まっていないかを確かめる。
// 検出器が止まると、scheduleのジョブの失敗が記録も通知もされない。
// 元のデータは、Windmillのジョブ履歴にある検出器自身の直近の成功した実行の完了時刻で、
// 検出器が成功を偽れない。見る側は別のscript(`default_worker_watch`)に置く。同じscriptで見ると、止まったときに誰も気づけない。
// 検出器と見る側が同時に止まる状態と、Windmillのserver、DB、ホストの共通の障害は拾わない。
// 定期ジョブ用workerが止まった状態は`periodic_worker.ts`の確認が拾う。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import {
  baselineRunsQuery,
  findBaselineRun,
  SCHEDULE_DETECTOR_PATH,
} from "./schedule_failure_scan.ts";
import { isRecord, isString, type NoticeRecord } from "./types.ts";

/**
 * 検出器が最後に成功してからこの時間を超えたら、止まったと見なす。
 * 定期ジョブ用workerの待ちのしきい値(`PERIODIC_JOB_WAIT_SECONDS`)に、検出器の間隔(5分)の2回分を足した値より長くする。
 * 待たされて遅れた回と、その次の回が続けて失敗しても、誤って知らせないためである。
 * 契約テストがこの関係を固定する。分で本文に出すので、60秒の倍数にする。
 */
export const SCHEDULE_DETECTOR_STALE_MS = 25 * 60 * 1000;

/**
 * 最後の成功より後に、見る側のscriptのscheduleの実行がこの回数以上完了していれば、検出器が動いていないと見なす。
 * ホストのスリープ明けは、どのscriptも動いていないので回数が少なく、止まったと決めつけない。
 */
export const SCHEDULE_DETECTOR_WATCH_RUNS = 3;

/** 確認全体が終わるまで待つ上限。確認が止まっても、見る側のscriptの他の確認を遅らせないための値。 */
export const SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS = 10_000;

/** 見る側のscriptのpath。このscriptのscheduleの実行を数える。 */
export const SCHEDULE_DETECTOR_WATCH_PATH = "f/factory/default_worker_watch";

/**
 * 通知の本文の、原因より前の固定の部分。
 * 通知を解決するときの先頭一致に使う。しきい値を変えても、変える前に残した未解決の通知を解決するため、
 * しきい値などの数字を含めない。
 */
export const SCHEDULE_DETECTOR_NOTICE_PREFIX =
  "scheduleの失敗の検出器(detect_schedule_failures)が";

const NOTICE_KIND = "schedule_detector_stale";

const STALLED_CAUSE = `${SCHEDULE_DETECTOR_NOTICE_PREFIX}${SCHEDULE_DETECTOR_STALE_MS / 60_000}分以上成功していません。scheduleのジョブが失敗しても、記録も通知もされません`;
const STALLED_ACTION =
  "wmill job list --script-path f/factory/detect_schedule_failures --limit 5で直近のジョブを見て、失敗のログを確かめる。ジョブが無いときは、wmill schedule get f/factory/detect_schedule_failures --jsonでenabledを確かめる。periodic_worker_missingの通知があれば、先にその案内に従う";

const DISABLED_CAUSE = `${SCHEDULE_DETECTOR_NOTICE_PREFIX}動いていません。検出器のscheduleが無効になっています。scheduleのジョブが失敗しても、記録も通知もされません`;
const DISABLED_ACTION =
  "mise run freeze:listで、検出器のscheduleの凍結を確かめる。凍結が無ければ、Windmillの画面で検出器のscheduleを有効にする";

/**
 * 検出器が成功していない間の通知。本文は原因ごとに固定の文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const SCHEDULE_DETECTOR_STALLED_NOTICE: NoticeRecord = {
  kind: NOTICE_KIND,
  message: `${STALLED_CAUSE}。次の操作: ${STALLED_ACTION}`,
};

/** 検出器のscheduleが無効になっているときの通知。 */
export const SCHEDULE_DETECTOR_DISABLED_NOTICE: NoticeRecord = {
  kind: NOTICE_KIND,
  message: `${DISABLED_CAUSE}。次の操作: ${DISABLED_ACTION}`,
};

/**
 * 判定の結果。
 * `stalled`は検出器が成功していない。`disabled`はそれに加えてscheduleが無効。
 * `unknown`は、読めない、スリープ明けや反映の直後で判定できないなど、知らせない状態である。
 */
export type ScheduleDetectorCheck = "ok" | "stalled" | "disabled" | "unknown";

export type ScheduleDetectorCheckDeps = {
  readonly workspace: string;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  /** 検出器のscheduleを返す。 */
  readonly getSchedule: (path: string) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 種類が一致し、本文が先頭で始まる未解決のnoticeを解決して、件数を返す。 */
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
  ) => Promise<number>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** 見る側のscriptのscheduleの実行が、`sinceMs`以降に開始して何回完了したかを返す。読めなければ`null`。 */
async function countWatchRuns(
  deps: ScheduleDetectorCheckDeps,
  sinceMs: number,
): Promise<number | null> {
  try {
    const response = await deps.listCompletedJobs({
      workspace: deps.workspace,
      schedulePath: SCHEDULE_DETECTOR_WATCH_PATH,
      startedAfter: new Date(sinceMs).toISOString(),
      orderDesc: true,
      perPage: 10,
    });
    if (!Array.isArray(response)) {
      deps.log.warn("could not count the runs of the watch script", {
        error: "the response is not a list",
      });
      return null;
    }
    return response.filter(
      (run) =>
        isRecord(run) && run.schedule_path === SCHEDULE_DETECTOR_WATCH_PATH,
    ).length;
  } catch (err) {
    deps.log.warn("could not count the runs of the watch script", {
      error: errorText(err),
    });
    return null;
  }
}

type ScheduleFacts = {
  readonly enabled: boolean | null;
  readonly editedAtMs: number | null;
};

function readScheduleFacts(schedule: unknown): ScheduleFacts {
  if (!isRecord(schedule)) {
    return { enabled: null, editedAtMs: null };
  }
  const editedAtMs = isString(schedule.edited_at)
    ? Date.parse(schedule.edited_at)
    : Number.NaN;
  return {
    enabled: typeof schedule.enabled === "boolean" ? schedule.enabled : null,
    editedAtMs: Number.isNaN(editedAtMs) ? null : editedAtMs,
  };
}

/** 検出器のscheduleを読む。読めなければ`null`を返す。 */
async function readSchedule(
  deps: ScheduleDetectorCheckDeps,
): Promise<ScheduleFacts | null> {
  try {
    return readScheduleFacts(await deps.getSchedule(SCHEDULE_DETECTOR_PATH));
  } catch (err) {
    deps.log.warn("could not read the schedule of the detector", {
      error: errorText(err),
    });
    return null;
  }
}

/** noticeを新しく挿入できたときだけDiscordに送る。どちらの失敗も呼び出し元に伝えない。 */
async function recordAndNotify(
  deps: ScheduleDetectorCheckDeps,
  notice: NoticeRecord,
  cause: string,
  nextAction: string,
): Promise<void> {
  try {
    const noticeId = await deps.addNotice(notice);
    if (noticeId !== null) {
      await deps.notify({
        kind: "schedule_detector_stale",
        instance_name: deps.instanceName,
        cause,
        next_action: nextAction,
      });
    }
  } catch (err) {
    deps.log.warn("could not record the schedule detector problem", {
      error: errorText(err),
    });
  }
}

/** 検出器が動いていると分かったので、残した通知を解決する。失敗しても呼び出し元に伝えない。 */
async function resolveRecovered(
  deps: ScheduleDetectorCheckDeps,
): Promise<void> {
  try {
    await deps.resolveNotices(NOTICE_KIND, SCHEDULE_DETECTOR_NOTICE_PREFIX);
  } catch (err) {
    deps.log.warn("could not resolve the schedule detector problem", {
      error: errorText(err),
    });
  }
}

async function report(
  deps: ScheduleDetectorCheckDeps,
  enabled: boolean | null,
): Promise<ScheduleDetectorCheck> {
  if (enabled === false) {
    await recordAndNotify(
      deps,
      SCHEDULE_DETECTOR_DISABLED_NOTICE,
      DISABLED_CAUSE,
      DISABLED_ACTION,
    );
    return "disabled";
  }
  await recordAndNotify(
    deps,
    SCHEDULE_DETECTOR_STALLED_NOTICE,
    STALLED_CAUSE,
    STALLED_ACTION,
  );
  return "stalled";
}

async function checkOnce(
  deps: ScheduleDetectorCheckDeps,
): Promise<ScheduleDetectorCheck> {
  let response: unknown;
  try {
    response = await deps.listCompletedJobs(baselineRunsQuery(deps.workspace));
  } catch (err) {
    deps.log.warn("could not list the runs of the schedule detector", {
      error: errorText(err),
    });
    return "unknown";
  }
  if (!Array.isArray(response)) {
    deps.log.warn("could not list the runs of the schedule detector", {
      error: "the response is not a list",
    });
    return "unknown";
  }
  const nowMs = deps.now();
  const run = findBaselineRun(response);

  if (run === null) {
    // 一度も成功していない。スケジュールを反映した直後は、まだ動いていないだけなので黙る。
    const schedule = await readSchedule(deps);
    if (schedule === null || schedule.editedAtMs === null) {
      return "unknown";
    }
    if (nowMs - schedule.editedAtMs < SCHEDULE_DETECTOR_STALE_MS) {
      return "unknown";
    }
    return await report(deps, schedule.enabled);
  }

  const completedAtMs = run.completedAtMs ?? run.startedAtMs;
  if (nowMs - completedAtMs <= SCHEDULE_DETECTOR_STALE_MS) {
    await resolveRecovered(deps);
    return "ok";
  }
  const watchRuns = await countWatchRuns(deps, completedAtMs);
  if (watchRuns === null || watchRuns < SCHEDULE_DETECTOR_WATCH_RUNS) {
    // 見る側のscriptも動いていないなら、ホストが止まっていただけで、検出器の不調とは限らない。
    return "unknown";
  }
  const schedule = await readSchedule(deps);
  return await report(deps, schedule === null ? null : schedule.enabled);
}

/**
 * `timeoutMs`以内に`work`が終わらなければ`fallback`を返す。
 * 呼び出し元の処理を止めないための上限で、`work`自体は中断しない。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 検出器が止まっていないかを確かめる。判定は次の表のとおりである。
 *
 * | 状態 | 結果 | 動き |
 * | --- | --- | --- |
 * | 最後の成功が`SCHEDULE_DETECTOR_STALE_MS`以内 | `ok` | 残した通知を解決する |
 * | 最後の成功がそれより古く、見る側のscheduleの実行がその後に3回以上完了している | `stalled` | 通知を残し、Discordに送る |
 * | 同じで、検出器のscheduleが無効 | `disabled` | 原因を分けた通知を残し、Discordに送る |
 * | 最後の成功が古く、見る側の実行が3回未満 | `unknown` | 何もしない(スリープ明けなど) |
 * | 成功が1件も無く、scheduleの更新が`SCHEDULE_DETECTOR_STALE_MS`以内 | `unknown` | 何もしない(反映の直後) |
 * | 成功が1件も無く、scheduleの更新がそれより古い | `stalled`、無効なら`disabled` | 通知を残し、Discordに送る |
 * | 履歴やscheduleを読めない、`timeoutMs`以内に終わらない | `unknown` | 何もしない。警告のログだけ残す |
 *
 * 検出器自身が履歴を読めずに失敗している間は、最後の成功が古くなるので、この確認が拾う。
 * 例外は投げない。
 */
export async function checkScheduleDetector(
  deps: ScheduleDetectorCheckDeps,
): Promise<ScheduleDetectorCheck> {
  const timeoutMs = deps.timeoutMs ?? SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS;
  return await withTimeout<ScheduleDetectorCheck>(
    checkOnce(deps),
    timeoutMs,
    "unknown",
    () => {
      deps.log.warn("schedule detector check timed out", {
        timeout_ms: timeoutMs,
      });
    },
  );
}
