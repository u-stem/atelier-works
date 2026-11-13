// 日本時間(JST)の扱い。
// 表示の整形は、`Intl.DateTimeFormat`に`Asia/Tokyo`を渡して行う。
// 日の境界の計算は、UTCとの差を足してからUTCの部品(`toISOString`など)で読む。
// 日本時間は夏時間を持たないので、固定の差で日本時間の日付になる。

/** 日本時間とUTCの差(ミリ秒)。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const CLOCK_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 時刻(エポックからのミリ秒)を、日本時間の`HH:MM`にする。秒は切り捨てる。有限の数でなければ`null`を返す。 */
export function formatJstClock(epochMs: number): string | null {
  return Number.isFinite(epochMs) ? CLOCK_FORMAT.format(epochMs) : null;
}
