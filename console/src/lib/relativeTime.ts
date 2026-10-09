// 時刻を「3分前」のような相対表記と、ツールチップに出す絶対表記にする。

const UNKNOWN_TIME_LABEL = "時刻不明";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

/**
 * `thenMs`が`nowMs`から見てどれだけ前かを日本語にする。
 * 1分未満と未来の時刻(端末の時計のずれ)は「たった今」にする。
 * 単位は分、時間、日、か月、年の順に、大きい単位へ切り替わる境目から変える。
 */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const elapsed = nowMs - thenMs;
  if (elapsed < MINUTE_MS) {
    return "たった今";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}分前`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}時間前`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  if (days < MONTH_DAYS) {
    return `${days}日前`;
  }
  if (days < YEAR_DAYS) {
    return `${Math.floor(days / MONTH_DAYS)}か月前`;
  }
  return `${Math.floor(days / YEAR_DAYS)}年前`;
}

/** ISO文字列の時刻を相対表記にする。読めない文字列は「時刻不明」にする。 */
export function formatRelativeIso(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  return Number.isNaN(thenMs)
    ? UNKNOWN_TIME_LABEL
    : formatRelativeTime(thenMs, nowMs);
}

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISO文字列の時刻を、日本時間の「2026年10月9日 21:34」の形にする。読めなければ「時刻不明」にする。 */
export function formatAbsoluteIso(iso: string): string {
  const thenMs = Date.parse(iso);
  return Number.isNaN(thenMs)
    ? UNKNOWN_TIME_LABEL
    : ABSOLUTE_FORMAT.format(thenMs);
}
