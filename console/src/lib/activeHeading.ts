// 目次で強調する節を決める。ブラウザの要素には触れず、見出しの位置だけから決める。

export type HeadingPosition = {
  readonly id: string;
  /** 見出しの上端の位置。基準線と同じ座標で測る。 */
  readonly top: number;
};

/**
 * 基準線に上端が届いた見出しのうち、文書の順で最後のものの`id`を返す。
 * 読み手は、基準線を過ぎた最後の見出しの節を読んでいるので、その節を強調する。
 * 最初の見出しにまだ届いていないときは`null`を返す。
 * 本文の底までスクロールしたとき(`atEnd`)は、最後の節が短くて基準線に届かないので、最後の見出しを選ぶ。
 * `positions`は文書の順に並べて渡す。
 */
export function activeHeadingId(
  positions: readonly HeadingPosition[],
  line: number,
  atEnd: boolean,
): string | null {
  if (atEnd) {
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
