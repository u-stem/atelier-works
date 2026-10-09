// 同じスケジュールの実行が続けて失敗していることを、要対応の通知にする。
// 1回の失敗はDiscordの通知で足りるが、PATの失効のように直るまで続く失敗は、
// 通知を見落とすとそのまま放置される。Consoleの要対応の一覧に残して拾う。
//
// 数えるのは、Windmillのジョブ履歴にあるスケジュールの実行そのものの成否である。
// `job_failures`の行は、成功した実行の中で記録する部分的な失敗(作業項目ごとの失敗など)も含むため、
// 数えると実行が成功しているのに失敗と判定してしまう。

import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** 直近のこの回数の実行がすべて失敗したら、続けて失敗しているとみなす。 */
export const SCHEDULE_FAILING_RUNS = 3;

/**
 * ジョブ履歴の応答(新しい順)の先頭`SCHEDULE_FAILING_RUNS`件がすべて失敗か。
 * 応答は信頼できない入力として読む。配列でないとき、件数が足りないとき、
 * 形の違う要素があるとき、取り消された実行があるときは`false`を返す。
 * 取り消しは失敗として数えない。人が止めた実行を、原因が続く失敗とみなさないため。
 */
export function allRecentRunsFailed(runs: unknown): boolean {
  if (!Array.isArray(runs) || runs.length < SCHEDULE_FAILING_RUNS) {
    return false;
  }
  return runs
    .slice(0, SCHEDULE_FAILING_RUNS)
    .every(
      (run) => isRecord(run) && run.success === false && run.canceled === false,
    );
}

/**
 * `flowPath`のスケジュールの実行が続けて失敗していることを知らせるnotice。
 * 本文は同じスケジュールでは同じ文にする。
 * 同じ本文の未解決のnoticeを、`addNoticeUnlessUnresolved`が重ねて記録しないため。
 */
export function buildScheduleFailingNotice(flowPath: string): NoticeRecord {
  return {
    kind: "schedule_failing",
    message: `スケジュール${flowPath}の直近${String(SCHEDULE_FAILING_RUNS)}回の実行が続けて失敗しています。失敗の内容を確かめて原因を直す。GitHubのPATの失効が原因のことがある`,
  };
}

export type FlagFailingScheduleDeps = {
  /** `flowPath`のジョブ履歴を新しい順に`count`件まで返す。 */
  readonly listRecentRuns: (
    flowPath: string,
    count: number,
  ) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

/**
 * 失敗のハンドラの最後に呼ぶ。直近`SCHEDULE_FAILING_RUNS`回の実行がすべて失敗なら、
 * noticeを残して`true`を返す。スケジュールの特定できない失敗(`unknown`)は数えない。
 * 履歴を読めないときは通知しない。失敗のハンドラを止めないよう、例外は投げず`false`を返す。
 */
export async function flagFailingSchedule(
  flowPath: string,
  deps: FlagFailingScheduleDeps,
): Promise<boolean> {
  if (flowPath === "unknown") {
    return false;
  }
  try {
    const runs = await deps.listRecentRuns(flowPath, SCHEDULE_FAILING_RUNS);
    if (!allRecentRunsFailed(runs)) {
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
