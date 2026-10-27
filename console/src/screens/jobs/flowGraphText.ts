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

/** キューが1ページで切れているときの文。強調が無いflowも、動いていないとは言えないためである。 */
export const QUEUE_TRUNCATED_NOTE =
  "キューが切れているため、強調の無いflowも動いている場合があります";

/** scheduleを読み切れていないときの文。添え書きが無い定期の入口も、動いていないとは言えないためである。 */
export const SCHEDULE_TRUNCATED_NOTE =
  "scheduleを読み切れていないため、添え書きの無い定期の入口があります";

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

const JST_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISOの時刻を、日本時間の「HH:MM」にする。読めなければ`null`。 */
function jstTime(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : JST_TIME.format(ms);
}

/**
 * scheduleの入口に添える語。止まっているときは「停止中」だけを出す。
 * 止まっているscheduleの直近の実行が成功でも、動いていないので、成功とは読ませない。
 * 動いているときは、直近の実行の成否と、次回の予定(日本時間)を添える。実行の時刻は添えない。
 */
export function scheduleWords(entry: ScheduleEntry | undefined): ScheduleWords {
  if (entry === undefined) return { last: null, next: null, stopped: false };
  if (entry.stopped) return { last: "停止中", next: null, stopped: true };
  const next = entry.nextRunAt === null ? null : jstTime(entry.nextRunAt);
  return {
    last:
      entry.lastRun === null
        ? null
        : entry.lastRun.success
          ? "直近 成功"
          : "直近 失敗・取消",
    next: next === null ? null : `次回 ${next}`,
    stopped: false,
  };
}

/**
 * 図の上に置く1行の要約。取得中は「取得中」、動いているflowが無ければその旨、あれば実行中と待ちの数を出す。
 * 図の強調が無いだけでは、読み込み前と、何も動いていない状態を見分けられないためである。
 * 取得に失敗したときと、まだ取得を頼んでいないときは、出さない。失敗は注記が伝える。
 * キューが切れているときは、無いとは言えないので、読めた範囲だと伝える。
 */
export function overviewWords(state: FlowGraphState): string | null {
  if (state.activePending) return "取得中";
  if (state.overlay === null) return null;
  let running = 0;
  let queued = 0;
  for (const activity of state.overlay.activity.values()) {
    running += activity.running;
    queued += activity.queued;
  }
  if (running === 0 && queued === 0) {
    return state.overlay.lowerBound
      ? "読めた範囲では、動いているflowはありません"
      : "いま動いているflowはありません";
  }
  return `実行中 ${String(running)}・待ち ${String(queued)}${state.overlay.lowerBound ? "以上" : ""}`;
}
