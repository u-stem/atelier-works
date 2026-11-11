// 日本時間(JST)とUTCの差。日本時間は夏時間を持たないので、固定の値でよい。
// 時刻に足してからUTCの部品(`getUTCHours`や`toISOString`)で読むと、日本時間の時刻と日付になる。

/** 日本時間とUTCの差(ミリ秒)。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
