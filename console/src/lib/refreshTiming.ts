// 自動で取り直す時刻と、最後に取れた時刻の表示。

const MINUTE_MS = 60_000;

const CLOCK_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 時刻(ミリ秒)を日本時間の「14:07」の形にする。 */
export function formatClockTime(ms: number): string {
  return CLOCK_FORMAT.format(ms);
}

/**
 * 自動更新の間隔を「2分ごとに自動更新」の形にする。
 * 1分に満たなければ秒で、それ以外は四捨五入した分で書く。
 */
export function formatAutoRefreshNote(intervalMs: number): string {
  if (intervalMs < MINUTE_MS) {
    return `${String(Math.round(intervalMs / 1000))}秒ごとに自動更新`;
  }
  return `${String(Math.round(intervalMs / MINUTE_MS))}分ごとに自動更新`;
}

/**
 * 次の自動更新までの時間を日本語にする。まだ取得していなければ`null`。
 * 残りは分に切り上げて「約2分後」とし、1分を切ったら「1分以内」、間隔を過ぎたら「まもなく」とする。
 * 切り上げるのは、実際より早く更新されるとは見せないためである。
 * 時計の値は30秒ごとにしか進まず、取得より古いことがある。残りは間隔を超えない値にそろえる。
 */
export function formatNextRefresh(
  updatedAtMs: number,
  nowMs: number,
  intervalMs: number,
): string | null {
  if (updatedAtMs <= 0) {
    return null;
  }
  const remaining = Math.min(intervalMs, updatedAtMs + intervalMs - nowMs);
  if (remaining <= 0) {
    return "まもなく";
  }
  if (remaining < MINUTE_MS) {
    return "1分以内";
  }
  return `約${Math.ceil(remaining / MINUTE_MS)}分後`;
}
