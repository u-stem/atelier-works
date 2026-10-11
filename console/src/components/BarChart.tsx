import { labelStride, layoutBars } from "../lib/barChart.ts";

export type BarChartDatum = {
  /** 棒を見分けるキー。同じグラフの中で重ならない値にする。 */
  readonly key: string;
  /** 横軸に出す文字。 */
  readonly label: string;
  readonly value: number;
};

const VIEW_WIDTH = 640;
const PLOT_HEIGHT = 150;
const VIEW_HEIGHT = 190;
const LABEL_BASELINE = 172;
const VALUE_LABEL_GAP = 4;

/** 横軸のラベルを並べる上限。超えたら間引く。 */
const MAX_AXIS_LABELS = 12;

/** 棒の上に値を出す本数の上限。超えると文字が重なるので、値は表で読む。 */
const MAX_VALUE_LABELS = 12;

/**
 * SVGで描く棒グラフ。色は文字のクラスで決め、実行時の入力から色や大きさを作らない。
 * 値は表にも出すことを前提にして、グラフ自体は読み上げの対象にせず、題だけを伝える。
 * 空の`data`は描かない。空の表示は呼び出し側が決める。
 */
export function BarChart({
  title,
  data,
  formatValue,
}: {
  title: string;
  data: readonly BarChartDatum[];
  formatValue: (value: number) => string;
}) {
  const bars = layoutBars(
    data.map((datum) => datum.value),
    { width: VIEW_WIDTH, height: PLOT_HEIGHT },
  );
  const stride = labelStride(data.length, MAX_AXIS_LABELS);
  const showValues = data.length <= MAX_VALUE_LABELS;
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      role="img"
      aria-label={`${title}の棒グラフ。数値は下の表にある`}
      className="h-auto w-full max-w-3xl"
    >
      <line
        x1={0}
        x2={VIEW_WIDTH}
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
                y={Math.max(bar.y - VALUE_LABEL_GAP, 10)}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {formatValue(datum.value)}
              </text>
            ) : null}
            {index % stride === 0 ? (
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
  );
}
