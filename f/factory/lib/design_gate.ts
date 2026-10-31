// 設計工程を開ける門。
// 設定の`design_enabled`が真で、`design_enabled_since`が日時として読めるときだけ開く。
// `lib/config.ts`と`console_config.ts`が同じ関数を呼ぶ。設定を読む全てのscriptが同じ結果を得るためである。
// 保護パスに置く。門の条件を書き換えると、設計工程が人の確認なしに開くため。
// importを持たない。門が別のファイルの挙動に左右されないようにする。
//
// `design_enabled_since`は、開けた時刻の記録と、開ける意思の表明に使う。
// 境の時刻としては使わないので、未来の日時でも開く。

/** 設計工程の門の結果。 */
export type DesignGate = {
  /** 設計工程が実際に動くか。 */
  readonly enabled: boolean;
  /** `design_enabled`が真と書かれているのに、開かなかったか。 */
  readonly ignored: boolean;
};

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * 秒まで書いたタイムゾーン付きのRFC 3339の日時か。
 * `Date.parse`は存在しない日(2月30日)や24時を黙って繰り上げるので、成分を自分で確かめる。
 */
function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offsetHour === undefined ||
    offsetMinute === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/**
 * `design_enabled_since`の生の値を日付にして返す。
 * 秒まで書いたタイムゾーン付きのRFC 3339の文字列だけを読む。それ以外は例外を投げず、`null`を返す。
 * 例外にすると、設定を読む全てのscriptが止まり、自己更新も、止まったことを知らせる通知も動かなくなるため。
 */
export function readDesignSince(since: unknown): Date | null {
  if (typeof since !== "string" || !isIsoDateTime(since)) {
    return null;
  }
  return new Date(since);
}

/**
 * 設計工程の門。
 * - 開く: `requested`が真で、`since`が日時として読めるとき。
 * - 無視する: `requested`が真なのに、`since`が無いか日時として読めないとき。閉じたまま、`ignored`を立てる。
 * - それ以外: 閉じたままで、`ignored`は立てない。
 */
export function resolveDesignGate(
  requested: boolean,
  since: unknown,
): DesignGate {
  const enabled = requested && readDesignSince(since) !== null;
  return { enabled, ignored: requested && !enabled };
}
