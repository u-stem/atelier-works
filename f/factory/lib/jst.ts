// 日本時間(JST)の扱い。BackendとConsoleで共有する。
// 表示の整形は、`Intl.DateTimeFormat`に`Asia/Tokyo`を渡して行う。
// 日の境界の計算は、UTCとの差を足してからUTCの部品で読む。
// 日本時間は夏時間を持たないので、固定の差で日本時間の日付になる。

/** 日本時間とUTCの差(ミリ秒)。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const PARTS_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type JstParts = {
  readonly date: string;
  readonly clock: string;
};

/**
 * 時刻を日本時間の部品に分ける。
 * `Intl.DateTimeFormat#format`は日付として読めない値で例外を投げるので、先に`Date`で確かめて`null`を返す。
 */
function jstParts(epochMs: number): JstParts | null {
  if (Number.isNaN(new Date(epochMs).getTime())) return null;
  const parts = new Map<string, string>();
  for (const part of PARTS_FORMAT.formatToParts(epochMs)) {
    parts.set(part.type, part.value);
  }
  const part = (type: string): string => parts.get(type) ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    clock: `${part("hour")}:${part("minute")}`,
  };
}

/** 時刻(エポックからのミリ秒)を、日本時間の`YYYY-MM-DD`にする。日付として読めなければ`null`を返す。 */
export function formatJstDate(epochMs: number): string | null {
  return jstParts(epochMs)?.date ?? null;
}

/** 時刻を、日本時間の`YYYY-MM-DD HH:mm`にする。秒は切り捨てる。日付として読めなければ`null`を返す。 */
export function formatJstMinute(epochMs: number): string | null {
  const parts = jstParts(epochMs);
  return parts === null ? null : `${parts.date} ${parts.clock}`;
}

/** 時刻を、日本時間の`HH:mm`にする。秒は切り捨てる。日付として読めなければ`null`を返す。 */
export function formatJstClock(epochMs: number): string | null {
  return jstParts(epochMs)?.clock ?? null;
}
