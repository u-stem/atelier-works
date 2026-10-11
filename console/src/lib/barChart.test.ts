import { describe, expect, test } from "bun:test";
import { labelStride, layoutBars } from "./barChart.ts";

const PLOT = { width: 100, height: 50 };

describe("layoutBars", () => {
  test("gives the largest value the full plot height", () => {
    expect(layoutBars([10, 5], PLOT)[0]?.height).toBe(50);
  });

  test("scales the other bars to the largest value", () => {
    expect(layoutBars([10, 5], PLOT)[1]?.height).toBe(25);
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

describe("labelStride", () => {
  test("labels every bar when they fit", () => {
    expect(labelStride(7, 12)).toBe(1);
  });

  test("skips bars so that the labels fit", () => {
    expect(labelStride(90, 12)).toBe(8);
  });

  test("never returns less than one", () => {
    expect(labelStride(0, 12)).toBe(1);
  });
});
