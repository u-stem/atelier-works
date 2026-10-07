// グラフのライブラリを使わず、SVGで直接描く最小限の棒グラフ。
// 分析タブのデータは小さく、単純な棒グラフで足りるため。

import React from "react";

export type BarChartDatum = {
  readonly label: string;
  readonly value: number;
};

type BarChartProps = {
  readonly data: readonly BarChartDatum[];
  readonly height?: number;
  readonly barColor?: string;
  readonly formatValue?: (value: number) => string;
};

const DEFAULT_HEIGHT = 180;
const BAR_WIDTH = 28;
const BAR_GAP = 10;
const LABEL_AREA_HEIGHT = 34;

function defaultFormatValue(value: number): string {
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

export function BarChart({
  data,
  height = DEFAULT_HEIGHT,
  barColor = "var(--accent)",
  formatValue = defaultFormatValue,
}: BarChartProps): React.ReactElement {
  if (data.length === 0) {
    return <p className="bar-chart-empty">データがありません</p>;
  }

  const maxValue = Math.max(...data.map((datum) => datum.value), 0);
  const chartHeight = height - LABEL_AREA_HEIGHT;
  const width = Math.max(data.length * (BAR_WIDTH + BAR_GAP), 200);

  return (
    <svg
      className="bar-chart"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="棒グラフ"
    >
      {data.map((datum, index) => {
        const barHeight =
          maxValue > 0 ? (datum.value / maxValue) * (chartHeight - 20) : 0;
        const x = index * (BAR_WIDTH + BAR_GAP);
        const y = chartHeight - barHeight;
        return (
          <g key={datum.label}>
            <text
              x={x + BAR_WIDTH / 2}
              y={Math.max(y - 4, 10)}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {formatValue(datum.value)}
            </text>
            <rect
              x={x}
              y={y}
              width={BAR_WIDTH}
              height={Math.max(barHeight, 1)}
              fill={barColor}
            />
            <text
              x={x + BAR_WIDTH / 2}
              y={chartHeight + 16}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {datum.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
