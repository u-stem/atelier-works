// 同じスケジュールが続けて失敗していることを、要対応の通知にする。
// 1回の失敗はDiscordの通知で足りるが、PATの失効のように直るまで続く失敗は、
// 通知を見落とすとそのまま放置される。Consoleの要対応の一覧に残して拾う。

import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

/** この回数以上、窓の中で失敗したスケジュールを、続けて失敗しているとみなす。 */
export const SCHEDULE_FAILING_THRESHOLD = 3;

/** 失敗を数える期間(時間)。 */
export const SCHEDULE_FAILING_WINDOW_HOURS = 24;

/** 窓の中の失敗の回数が、続けて失敗しているとみなす回数に達したか。 */
export function isScheduleFailing(failureCount: number): boolean {
  return failureCount >= SCHEDULE_FAILING_THRESHOLD;
}

/**
 * `flowPath`のスケジュールが続けて失敗していることを知らせるnotice。
 * 本文は回数を含めず、同じスケジュールでは同じ文にする。
 * 同じ本文の未解決のnoticeを、`addNoticeUnlessUnresolved`が重ねて記録しないため。
 */
export function buildScheduleFailingNotice(flowPath: string): NoticeRecord {
  return {
    kind: "schedule_failing",
    message: `スケジュール${flowPath}が直近${String(SCHEDULE_FAILING_WINDOW_HOURS)}時間に${String(SCHEDULE_FAILING_THRESHOLD)}回以上失敗しています。失敗の内容を確かめて原因を直す。GitHubのPATの失効が原因のことがある`,
  };
}

export type FlagFailingScheduleDeps = {
  /** `flowPath`の失敗のうち、`since`以降の件数を返す。 */
  readonly countFailuresSince: (
    flowPath: string,
    since: Date,
  ) => Promise<number>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

/**
 * 失敗を記録した直後に呼ぶ。直近`SCHEDULE_FAILING_WINDOW_HOURS`時間の失敗が
 * `SCHEDULE_FAILING_THRESHOLD`回以上なら、noticeを残して`true`を返す。
 * スケジュールの特定できない失敗(`unknown`)は数えない。
 * 失敗のハンドラを止めないよう、例外は投げず、失敗したときは`false`を返す。
 */
export async function flagFailingSchedule(
  flowPath: string,
  now: Date,
  deps: FlagFailingScheduleDeps,
): Promise<boolean> {
  if (flowPath === "unknown") {
    return false;
  }
  try {
    const since = new Date(
      now.getTime() - SCHEDULE_FAILING_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const count = await deps.countFailuresSince(flowPath, since);
    if (!isScheduleFailing(count)) {
      return false;
    }
    await deps.addNotice(buildScheduleFailingNotice(flowPath));
    return true;
  } catch (err) {
    deps.log.error("failed to flag a failing schedule", {
      error: maskSecrets(String(err)),
    });
    return false;
  }
}
