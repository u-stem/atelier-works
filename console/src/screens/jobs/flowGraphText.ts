// 起動関係の図に添える語を組み立てる。語は記号と並べて示し、色だけに頼らない。

import type { NodeActivity, ScheduleRun } from "../../lib/flowOverlay.ts";

/** 実行中と待ちの取得に失敗したときの文。強調が無いことを、動いていないと読ませないために出す。 */
export const ACTIVE_READ_FAILED_NOTE = "";

/** scheduleの直近の結果の取得に失敗したときの文。 */
export const SCHEDULE_READ_FAILED_NOTE = "";

export type ActivityWords = {
  readonly running: string | null;
  readonly queued: string | null;
};

export function activityWords(
  _activity: NodeActivity | undefined,
  _lowerBound: boolean,
): ActivityWords {
  return { running: null, queued: null };
}

export function scheduleRunWords(_run: ScheduleRun | undefined): string | null {
  return null;
}
