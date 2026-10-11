// 自動で取り直す間隔の表示。

const MINUTE_MS = 60_000;

/**
 * 自動更新の間隔を「2分ごとに自動更新」の形にする。
 * 分で割り切れるときだけ分で書き、それ以外は秒で書く。実際の間隔と違う値を見せないためである。
 */
export function formatAutoRefreshNote(intervalMs: number): string {
  if (intervalMs >= MINUTE_MS && intervalMs % MINUTE_MS === 0) {
    return `${String(intervalMs / MINUTE_MS)}分ごとに自動更新`;
  }
  return `${String(Math.round(intervalMs / 1000))}秒ごとに自動更新`;
}
