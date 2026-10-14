// 棒グラフの配置の計算。描画はコンポーネントが行い、ここは座標と文字の収まりだけを返す。
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

/** 0より大きい値の棒が、最大との差が大きくても見えるようにする、最小の高さ。 */
const MIN_BAR_HEIGHT = 1;

/** 最大の棒の上に残す、値のラベルの置き場の高さ。 */
export const VALUE_LABEL_ROOM = 16;

/** ラベルの文字の大きさ(px)。幅の見積もりに使う。 */
const LABEL_FONT_SIZE = 11;

/** 半角の文字の幅の、文字の大きさに対する比。数字や英字を平均して見積もる。 */
const NARROW_CHAR_RATIO = 0.6;

/** 隣のラベルとの間に空ける幅(px)。 */
const LABEL_GAP = 8;

export type AxisLabelPlacement = {
  readonly x: number;
  readonly anchor: "start" | "middle" | "end";
};

/**
 * 横軸のラベルの置き場所。棒の中心`center`に中央揃えで置く。
 * ラベルが描画領域の端を越えるときは、その端に寄せて、はみ出して切れるのを防ぐ。
 * 幅は`estimateLabelWidth`の見積もりで決める。
 */
export function placeAxisLabel(
  center: number,
  label: string,
  plotWidth: number,
): AxisLabelPlacement {
  const half = estimateLabelWidth(label) / 2;
  if (center + half > plotWidth) {
    return { x: plotWidth, anchor: "end" };
  }
  if (center - half < 0) {
    return { x: 0, anchor: "start" };
  }
  return { x: center, anchor: "middle" };
}

/**
 * 横軸のラベルを、`index`番目の棒に付けるか。
 * 間引くときは最後の棒を基準にして`stride`本おきに付ける。
 * 日の並びで、いちばん読みたい最新の日にラベルを残すためである。
 */
export function isLabeledIndex(
  index: number,
  count: number,
  stride: number,
): boolean {
  return (count - 1 - index) % stride === 0;
}

/** グラフの幅(px)の下限。測る前と、狭い画面で、ラベルの計算が崩れないようにする。 */
export const MIN_PLOT_WIDTH = 320;

/**
 * 測った領域の幅(px)を、グラフの幅にする。
 * 文字の大きさを変えずに画面の幅へ合わせるため、グラフは測った幅をそのまま座標の幅に使う。
 * 小数は切り捨て、下限を下回る値や数でない値は下限にする。
 */
export function resolvePlotWidth(measured: number): number {
  return Number.isFinite(measured)
    ? Math.max(Math.floor(measured), MIN_PLOT_WIDTH)
    : MIN_PLOT_WIDTH;
}

/**
 * 値の並びを、描画領域に収まる棒の座標にする。
 * 最大の値の棒は、領域の高さから`VALUE_LABEL_ROOM`を引いた高さになり、その上に値のラベルが入る。
 * ほかの値はその比で決まる。値が0の棒は高さ0にし、軸の線だけが残る。
 * 0より大きい値は、最小の高さを確保する。値はすべて0以上を前提にする。
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
  const tallest = Math.max(plot.height - VALUE_LABEL_ROOM, MIN_BAR_HEIGHT);
  return values.map((value, index) => {
    const height =
      value > 0 && max > 0
        ? Math.max((value / max) * tallest, MIN_BAR_HEIGHT)
        : 0;
    return {
      x: index * slot + (slot - width) / 2,
      y: plot.height - height,
      width,
      height,
    };
  });
}

/**
 * ラベルの文字列が占める幅(px)の見積もり。
 * ASCIIの範囲は半角、それ以外は全角として数える。フォントの実測はしない。
 */
export function estimateLabelWidth(label: string): number {
  let width = 0;
  for (const char of label) {
    const isNarrow = (char.codePointAt(0) ?? 0) < 0x80;
    width += LABEL_FONT_SIZE * (isNarrow ? NARROW_CHAR_RATIO : 1);
  }
  return width;
}

/**
 * 横軸のラベルを何本おきに出せば、隣と重ならないか。
 * 最も長いラベルの幅に間隔を足し、1本分の幅で割って切り上げる。
 * 1本おき未満にはならず、ラベルが無ければ1にする。
 */
export function labelStride(
  labels: readonly string[],
  plotWidth: number,
): number {
  if (labels.length === 0) {
    return 1;
  }
  const longest = Math.max(...labels.map(estimateLabelWidth));
  const slot = plotWidth / labels.length;
  return Math.max(1, Math.ceil((longest + LABEL_GAP) / slot));
}
