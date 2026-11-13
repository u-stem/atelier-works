// 日本時間(JST)の扱い。BackendとConsoleで共有する。
// 表示の整形は、`Intl.DateTimeFormat`に`Asia/Tokyo`を渡して行う。
// 日の境界の計算は、UTCとの差を足してからUTCの部品で読む。
// 日本時間は夏時間を持たないので、固定の差で日本時間の日付になる。

/** 日本時間とUTCの差(ミリ秒)。 */
export const JST_OFFSET_MS = 0;

/** 時刻(エポックからのミリ秒)を、日本時間の`YYYY-MM-DD`にする。日付として読めなければ`null`を返す。 */
export function formatJstDate(_epochMs: number): string | null {
  return "";
}

/** 時刻を、日本時間の`YYYY-MM-DD HH:mm`にする。秒は切り捨てる。日付として読めなければ`null`を返す。 */
export function formatJstMinute(_epochMs: number): string | null {
  return "";
}

/** 時刻を、日本時間の`YYYY-MM-DD HH:mm:ss`にする。日付として読めなければ`null`を返す。 */
export function formatJstSecond(_epochMs: number): string | null {
  return "";
}

/** 時刻を、日本時間の`HH:mm`にする。秒は切り捨てる。日付として読めなければ`null`を返す。 */
export function formatJstClock(_epochMs: number): string | null {
  return "";
}
