// 棒グラフの配置の計算。描画はコンポーネントが行い、ここは座標だけを返す。
// グラフのライブラリを使わず、色と大きさを実行時の入力に依存させないためである。

export type BarGeometry = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PlotSize = {
  readonly width: number;
  readonly height: number;
};

/** 棒1本の幅の上限。本数が少ないときに棒が太くなりすぎないようにする。 */
const MAX_BAR_WIDTH = 36;

/** 1本分の幅のうち、棒が占める割合。残りは隣との間隔になる。 */
const BAR_FILL_RATIO = 0.7;

/** 値が0でも棒が見えるようにする、最小の高さ。 */
const MIN_BAR_HEIGHT = 1;

/**
 * 値の並びを、描画領域に収まる棒の座標にする。
 * 最大の値が領域の高さいっぱいになり、ほかの値はその比で決まる。
 * 値が0の棒も、細い線として残す。値はすべて0以上を前提にする。
 */
export function layoutBars(
  values: readonly number[],
  plot: PlotSize,
): BarGeometry[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values);
  const slot = plot.width / values.length;
  const width = Math.min(slot * BAR_FILL_RATIO, MAX_BAR_WIDTH);
  return values.map((value, index) => {
    const height =
      max > 0
        ? Math.max((value / max) * plot.height, MIN_BAR_HEIGHT)
        : MIN_BAR_HEIGHT;
    return {
      x: index * slot + (slot - width) / 2,
      y: plot.height - height,
      width,
      height,
    };
  });
}

/**
 * 横軸のラベルを何本おきに出すか。`maxLabels`個に収まるまで間引く。
 * 1本おき未満にはならない。
 */
export function labelStride(count: number, maxLabels: number): number {
  if (count <= maxLabels) {
    return 1;
  }
  return Math.ceil(count / maxLabels);
}
