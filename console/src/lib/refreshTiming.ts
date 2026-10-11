// 自動で取り直す間隔の表示。

const MINUTE_MS = 60_000;

/**
 * 自動更新の間隔を「2分ごとに自動更新」の形にする。
 * 取得が失敗しているときは、更新できているとは読めないよう「2分ごとに自動で再試行」にする。
 * 分で割り切れるときだけ分で書き、それ以外は秒で書く。実際の間隔と違う値を見せないためである。
 */
export function formatAutoRefreshNote(
  intervalMs: number,
  failed: boolean,
): string {
  const interval =
    intervalMs >= MINUTE_MS && intervalMs % MINUTE_MS === 0
      ? `${String(intervalMs / MINUTE_MS)}分`
      : `${String(Math.round(intervalMs / 1000))}秒`;
  return `${interval}ごとに自動${failed ? "で再試行" : "更新"}`;
}
