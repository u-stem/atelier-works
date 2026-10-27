// 起動関係の図に添える語を組み立てる。語は記号と並べて示し、色だけに頼らない。

import type {
  FlowGraphState,
  NodeActivity,
  ScheduleEntry,
} from "../../lib/flowOverlay.ts";

/** 実行中と待ちの取得に失敗したときの文。強調が無いことを、動いていないと読ませないために出す。 */
export const ACTIVE_READ_FAILED_NOTE = "実行の状態を読めませんでした";

/** scheduleの直近の結果の取得に失敗したときの文。 */
export const SCHEDULE_READ_FAILED_NOTE =
  "定期の入口の直近の結果を読めませんでした";

/** キューが1ページで切れているときの文。 */
export const QUEUE_TRUNCATED_NOTE = "";

/** scheduleを読み切れていないときの文。 */
export const SCHEDULE_TRUNCATED_NOTE = "";

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

export type ScheduleWords = {
  /** 止まっているときは「停止中」、それ以外は直近の実行の語。 */
  readonly last: string | null;
  /** 次回の予定。止まっているときは添えない。 */
  readonly next: string | null;
  readonly stopped: boolean;
};

export function scheduleWords(
  _entry: ScheduleEntry | undefined,
): ScheduleWords {
  return { last: null, next: null, stopped: false };
}

/** 図の上に置く1行の要約。値が無いとき(読んでいない、失敗)は`null`。 */
export function overviewWords(_state: FlowGraphState): string | null {
  return null;
}
