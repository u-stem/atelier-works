// 起動関係の図に添える語を組み立てる。語は記号と並べて示し、色だけに頼らない。

import type { NodeActivity, ScheduleRun } from "../../lib/flowOverlay.ts";

/** 実行中と待ちの取得に失敗したときの文。強調が無いことを、動いていないと読ませないために出す。 */
export const ACTIVE_READ_FAILED_NOTE = "実行の状態を読めませんでした";

/** scheduleの直近の結果の取得に失敗したときの文。 */
export const SCHEDULE_READ_FAILED_NOTE =
  "定期の入口の直近の結果を読めませんでした";

export type ActivityWords = {
  readonly running: string | null;
  readonly queued: string | null;
};

/**
 * flowのノードに添える語。実行中は「実行中」、待ちは「待ちN」。
 * キューが切れていて件数が下限のときは、待ちの件数に「以上」を付ける。
 * 実行中は有無だけを示すので、件数も「以上」も付けない。
 */
export function activityWords(
  activity: NodeActivity | undefined,
  lowerBound: boolean,
): ActivityWords {
  return {
    running: activity !== undefined && activity.running > 0 ? "実行中" : null,
    queued:
      activity !== undefined && activity.queued > 0
        ? `待ち${String(activity.queued)}${lowerBound ? "以上" : ""}`
        : null,
  };
}

/**
 * scheduleの入口に添える、直近の実行の語。実行の記録が無いときは添えない。
 * 失敗と取消は、スケジュールのタブと同じく区別しない。
 */
export function scheduleRunWords(run: ScheduleRun | undefined): string | null {
  if (run === undefined) return null;
  return run.success ? "直近 成功" : "直近 失敗・取消";
}
