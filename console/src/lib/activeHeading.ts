// 目次で強調する節を決める。ブラウザの要素には触れず、見出しの位置だけから決める。

export type HeadingPosition = {
  readonly id: string;
  /** 見出しの上端の位置。基準線と同じ座標で測る。 */
  readonly top: number;
};

/** URLのハッシュが指す見出しが、枠の中に見えているかを調べるための情報。 */
export type HashView = {
  /** ハッシュが指す`id`。無いときは`null`。 */
  readonly hashId: string | null;
  readonly frameTop: number;
  readonly frameBottom: number;
};

/**
 * 基準線に上端が届いた見出しのうち、文書の順で最後のものの`id`を返す。
 * 読み手は、基準線を過ぎた最後の見出しの節を読んでいるので、その節を強調する。
 * 最初の見出しにまだ届いていないときは`null`を返す。
 * 本文の底までスクロールしたとき(`atEnd`)は、最後の節が短くて基準線に届かないので、最後の見出しを選ぶ。
 * ただし、底に短い節が複数あり、目次のリンクで最後から2番目の節へ移ったときは、
 * ハッシュが指す見出しが枠の中に見えていれば、そちらを選ぶ。クリックした節と強調を一致させるためである。
 * `positions`は文書の順に並べて渡す。
 */
export function activeHeadingId(
  positions: readonly HeadingPosition[],
  line: number,
  atEnd: boolean,
  view?: HashView,
): string | null {
  if (atEnd) {
    const hashed = positions.find((position) => position.id === view?.hashId);
    if (
      view !== undefined &&
      hashed !== undefined &&
      hashed.top >= view.frameTop &&
      hashed.top < view.frameBottom
    ) {
      return hashed.id;
    }
    return positions.at(-1)?.id ?? null;
  }
  let active: string | null = null;
  for (const position of positions) {
    if (position.top <= line) {
      active = position.id;
    }
  }
  return active;
}

/** スクロールする枠の寸法。 */
export type ScrollMetrics = {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
};

/**
 * 枠が底までスクロールされているかを返す。
 * 小数のスクロール位置の丸めを許すため、残りが1px以下なら底とみなす。
 * スクロールできない短い文書は、最初から全体が見えているので、底とはみなさない。
 */
export function isScrolledToEnd({
  scrollTop,
  clientHeight,
  scrollHeight,
}: ScrollMetrics): boolean {
  return (
    scrollHeight > clientHeight && scrollTop + clientHeight >= scrollHeight - 1
  );
}

/**
 * `location.hash`から見出しの`id`を取り出す。
 * ハッシュが空のときと、百分率符号の並びが壊れているときは`null`を返す。
 */
export function hashToHeadingId(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
