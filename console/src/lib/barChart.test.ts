import { describe, expect, test } from "bun:test";
import {
  estimateLabelWidth,
  isLabeledIndex,
  labelStride,
  layoutBars,
  MIN_PLOT_WIDTH,
  placeAxisLabel,
  resolvePlotWidth,
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

  test("draws no bar for a zero value", () => {
    expect(layoutBars([10, 0], PLOT)[1]?.height).toBe(0);
  });

  test("draws no bar at all when every value is zero", () => {
    expect(layoutBars([0, 0], PLOT).map((bar) => bar.height)).toEqual([0, 0]);
  });

  test("keeps a value far below the tallest one visible", () => {
    expect(layoutBars([100000, 1], PLOT)[1]?.height).toBe(1);
  });

  test("rests a zero value on the bottom of the plot", () => {
    expect(layoutBars([10, 0], PLOT)[1]?.y).toBe(PLOT.height);
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
  test("counts a full-width character as the text-caption size (12px)", () => {
    expect(estimateLabelWidth("あ")).toBe(12);
  });

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

  test("labels more bars on a wider plot", () => {
    expect(labelStride(days(90), 1200)).toBeLessThan(
      labelStride(days(90), 640),
    );
  });
});

describe("placeAxisLabel", () => {
  test("centers a label that fits inside the plot", () => {
    expect(placeAxisLabel(50, "10/8", 100)).toEqual({
      x: 50,
      anchor: "middle",
    });
  });

  test("anchors a label that would pass the right edge to the right edge", () => {
    expect(placeAxisLabel(98, "10/11", 100)).toEqual({ x: 100, anchor: "end" });
  });

  test("anchors a label that would pass the left edge to the left edge", () => {
    expect(placeAxisLabel(2, "10/11", 100)).toEqual({ x: 0, anchor: "start" });
  });

  test("keeps a label that ends exactly at the right edge centered", () => {
    const half = estimateLabelWidth("10/11") / 2;
    expect(placeAxisLabel(100 - half, "10/11", 100).anchor).toBe("middle");
  });

  test("centers the label of the last of 7 bars at the minimum width", () => {
    const bars = layoutBars([1, 1, 1, 1, 1, 1, 1], {
      width: MIN_PLOT_WIDTH,
      height: 50,
    });
    const last = bars.at(-1);
    const center = last === undefined ? 0 : last.x + last.width / 2;
    expect(placeAxisLabel(center, "10/11", MIN_PLOT_WIDTH).anchor).toBe(
      "middle",
    );
  });

  test("anchors the label of the last of 90 bars at a width of 1000 to the right edge", () => {
    const bars = layoutBars(
      Array.from({ length: 90 }, () => 1),
      {
        width: 1000,
        height: 50,
      },
    );
    const last = bars.at(-1);
    const center = last === undefined ? 0 : last.x + last.width / 2;
    expect(placeAxisLabel(center, "10/11", 1000).anchor).toBe("end");
  });
});

describe("isLabeledIndex", () => {
  test("labels the last bar", () => {
    expect(isLabeledIndex(89, 90, 6)).toBe(true);
  });

  test("labels the bars a whole stride before the last one", () => {
    expect(isLabeledIndex(83, 90, 6)).toBe(true);
  });

  test("skips the bars between the labeled ones", () => {
    expect(isLabeledIndex(86, 90, 6)).toBe(false);
  });

  test("does not label the first bar when the stride does not reach it", () => {
    expect(isLabeledIndex(0, 90, 6)).toBe(false);
  });

  test("labels every bar for a stride of one", () => {
    expect(isLabeledIndex(3, 10, 1)).toBe(true);
  });
});

describe("resolvePlotWidth", () => {
  test("follows the measured width of the container", () => {
    expect(resolvePlotWidth(1000)).toBe(1000);
  });

  test("rounds a fractional width down", () => {
    expect(resolvePlotWidth(812.7)).toBe(812);
  });

  test("keeps a minimum width for a narrow container", () => {
    expect(resolvePlotWidth(100)).toBe(MIN_PLOT_WIDTH);
  });

  test("falls back to the minimum width before the first measurement", () => {
    expect(resolvePlotWidth(0)).toBe(MIN_PLOT_WIDTH);
  });

  test("falls back to the minimum width for a value that is not a width", () => {
    expect(resolvePlotWidth(Number.NaN)).toBe(MIN_PLOT_WIDTH);
  });
});
