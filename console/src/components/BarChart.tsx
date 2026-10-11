import { labelStride, layoutBars, resolvePlotWidth } from "../lib/barChart.ts";
import { useElementWidth } from "../lib/useElementWidth.ts";

export type BarChartDatum = {
  /** 棒を見分けるキー。同じグラフの中で重ならない値にする。 */
  readonly key: string;
  /** 横軸に出す文字。 */
  readonly label: string;
  readonly value: number;
};

const PLOT_HEIGHT = 150;
const VIEW_HEIGHT = 190;
const LABEL_BASELINE = 172;
const VALUE_LABEL_GAP = 4;

/**
 * SVGで描く棒グラフ。色は文字のクラスで決め、実行時の入力から色や大きさを作らない。
 * 値は表にも出すことを前提にして、グラフ自体は読み上げの対象にせず、題だけを伝える。
 * 空の`data`は描かない。空の表示は呼び出し側が決める。
 *
 * 幅は置かれた領域に合わせて測り、文字の大きさを変えずに棒の間隔だけを広げる。
 * 棒の上の値と横軸のラベルは、文字の幅の見積もりが1本分の幅に収まるときだけ出す。
 * 収まらないとき、`axis`が`sequence`(日のような連続する並び)なら横軸のラベルを間引く。
 * `category`(状態のような別々の項目)では、間引くと棒が何か分からなくなるので、
 * 横軸のラベルを出さず、表で読ませる。
 */
export function BarChart({
  title,
  data,
  axis,
  formatValue,
}: {
  title: string;
  data: readonly BarChartDatum[];
  axis: "sequence" | "category";
  formatValue: (value: number) => string;
}) {
  const { ref, width } = useElementWidth();
  const viewWidth = resolvePlotWidth(width);
  const bars = layoutBars(
    data.map((datum) => datum.value),
    { width: viewWidth, height: PLOT_HEIGHT },
  );
  const axisStride = labelStride(
    data.map((datum) => datum.label),
    viewWidth,
  );
  const showAxisLabels = axis === "sequence" || axisStride === 1;
  const stride = axis === "sequence" ? axisStride : 1;
  const showValues =
    labelStride(
      data.map((datum) => formatValue(datum.value)),
      viewWidth,
    ) === 1;
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg
        width={viewWidth}
        height={VIEW_HEIGHT}
        viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={`${title}の棒グラフ。数値は下の表にある`}
        className="block"
      >
        <line
          x1={0}
          x2={viewWidth}
          y1={PLOT_HEIGHT}
          y2={PLOT_HEIGHT}
          className="stroke-border"
        />
        {data.map((datum, index) => {
          const bar = bars[index];
          if (bar === undefined) {
            return null;
          }
          const center = bar.x + bar.width / 2;
          return (
            <g key={datum.key}>
              <rect
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx={2}
                className="fill-primary"
              />
              {showValues ? (
                <text
                  x={center}
                  y={bar.y - VALUE_LABEL_GAP}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {formatValue(datum.value)}
                </text>
              ) : null}
              {showAxisLabels && index % stride === 0 ? (
                <text
                  x={center}
                  y={LABEL_BASELINE}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {datum.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
