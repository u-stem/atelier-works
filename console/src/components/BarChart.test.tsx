import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MIN_PLOT_WIDTH } from "../lib/barChart.ts";
import { BarChart, type BarChartDatum } from "./BarChart.tsx";

const DATA: readonly BarChartDatum[] = [
  { key: "a", label: "10/1", value: 3 },
  { key: "b", label: "10/2", value: 0 },
];

function render(axis: "sequence" | "category"): string {
  return renderToStaticMarkup(
    <BarChart
      title="日別実行件数"
      data={DATA}
      axis={axis}
      formatValue={String}
    />,
  );
}

describe("BarChart", () => {
  test("draws at the minimum width before the container is measured", () => {
    expect(render("sequence")).toContain(`<svg width="${MIN_PLOT_WIDTH}"`);
  });

  test("draws a bar only for a value above zero", () => {
    expect(render("sequence").match(/<rect /g)?.length).toBe(1);
  });

  test("does not cap the width of a sequence chart", () => {
    expect(render("sequence")).not.toContain("max-w-3xl");
  });

  test("keeps the label of the newest day when thinning the labels", () => {
    const days: readonly BarChartDatum[] = Array.from(
      { length: 90 },
      (_, index) => ({
        key: String(index),
        label: `d${index + 1}`,
        value: 1,
      }),
    );
    const html = renderToStaticMarkup(
      <BarChart
        title="日別実行件数"
        data={days}
        axis="sequence"
        formatValue={String}
      />,
    );
    expect(html).toContain(">d90<");
  });

  test("caps the width of a category chart", () => {
    expect(render("category")).toContain("max-w-3xl");
  });
});
