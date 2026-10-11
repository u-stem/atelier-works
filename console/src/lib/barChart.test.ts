import { describe, expect, test } from "bun:test";
import {
  estimateLabelWidth,
  labelStride,
  layoutBars,
  VALUE_LABEL_ROOM,
} from "./barChart.ts";

const PLOT = { width: 100, height: 50 };

describe("layoutBars", () => {
  test("leaves room above the tallest bar for its value label", () => {
    expect(layoutBars([10, 5], PLOT)[0]?.y).toBe(VALUE_LABEL_ROOM);
  });

  test("scales the other bars to the tallest one", () => {
    const tallest = PLOT.height - VALUE_LABEL_ROOM;
    expect(layoutBars([10, 5], PLOT)[1]?.height).toBe(tallest / 2);
  });

  test("rests every bar on the bottom of the plot", () => {
    const bars = layoutBars([10, 5], PLOT);
    expect(bars.map((bar) => bar.y + bar.height)).toEqual([50, 50]);
  });

  test("keeps a zero value visible as a thin line", () => {
    expect(layoutBars([10, 0], PLOT)[1]?.height).toBe(1);
  });

  test("draws a thin line for every bar when all values are zero", () => {
    expect(layoutBars([0, 0], PLOT).map((bar) => bar.height)).toEqual([1, 1]);
  });

  test("places the bars side by side without overlap", () => {
    const bars = layoutBars([1, 1, 1], PLOT);
    const first = bars[0];
    const second = bars[1];
    expect(
      first !== undefined &&
        second !== undefined &&
        first.x + first.width <= second.x,
    ).toBe(true);
  });

  test("keeps the last bar inside the plot width", () => {
    const last = layoutBars([1, 1, 1], PLOT).at(-1);
    expect(last !== undefined && last.x + last.width <= PLOT.width).toBe(true);
  });

  test("returns no bars for no values", () => {
    expect(layoutBars([], PLOT)).toEqual([]);
  });
});

describe("estimateLabelWidth", () => {
  test("counts a full width character as wider than a half width one", () => {
    expect(estimateLabelWidth("あ")).toBeGreaterThan(estimateLabelWidth("a"));
  });

  test("grows with the number of characters", () => {
    expect(estimateLabelWidth("10/8")).toBeGreaterThan(estimateLabelWidth("1"));
  });
});

describe("labelStride", () => {
  const days = (count: number) =>
    Array.from({ length: count }, (_, index) => `10/${index + 1}`);

  test("labels every bar when the labels fit", () => {
    expect(labelStride(days(7), 640)).toBe(1);
  });

  test("skips bars so that 90 days of labels do not overlap", () => {
    expect(labelStride(days(90), 640)).toBeGreaterThan(1);
  });

  test("skips more bars for long Japanese labels than for short ones", () => {
    const long = Array.from({ length: 8 }, () => "要件定義の生成中");
    const short = Array.from({ length: 8 }, () => "失敗");
    expect(labelStride(long, 640)).toBeGreaterThan(labelStride(short, 640));
  });

  test("lets the stride cover a label wider than its slot", () => {
    const labels = days(90);
    const slot = 640 / labels.length;
    expect(labelStride(labels, 640) * slot).toBeGreaterThanOrEqual(
      estimateLabelWidth("10/90"),
    );
  });

  test("returns one for no labels", () => {
    expect(labelStride([], 640)).toBe(1);
  });
});
