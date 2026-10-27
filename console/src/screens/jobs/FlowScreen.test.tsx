import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { FLOWS_DATA, type FlowsData } from "../../lib/flowsData.ts";
import { FlowScreenView } from "./FlowScreen.tsx";

function render(
  options: {
    name?: string;
    data?: FlowsData | null;
    back?: string | null;
    width?: number;
  } = {},
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <FlowScreenView
            name={options.name ?? "pipeline"}
            data={"data" in options ? (options.data ?? null) : FLOWS_DATA}
            back={options.back ?? null}
            width={options.width ?? 1100}
          />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("FlowScreenView: a known flow", () => {
  test("names the flow in the heading", () => {
    expect(render()).toMatch(/<h1[^>]*>pipeline<\/h1>/);
  });

  test("writes the summary of the flow", () => {
    expect(render()).toContain("要件定義の生成と承認");
  });

  test("writes the description of the flow", () => {
    expect(render()).toContain("却下された場合はフィードバックをもとに");
  });

  test("shows the diagram", () => {
    expect(render()).toContain("<svg");
  });

  test("links to the history of the flow", () => {
    expect(render()).toContain(
      'href="/jobs?tab=history&amp;script=f%2Ffactory%2Fpipeline"',
    );
  });

  test("goes back to the list by the breadcrumb", () => {
    expect(render()).toContain('href="/jobs"');
  });

  test("goes back to the tab it came from", () => {
    expect(render({ back: "/jobs?tab=schedules" })).toContain(
      'href="/jobs?tab=schedules"',
    );
  });

  test("draws a list instead of a diagram in a narrow width", () => {
    expect(render({ width: 400 })).not.toContain("<svg");
  });

  test("shows no state of a job, because the diagram is static", () => {
    expect(render()).not.toContain("実行中");
  });
});

describe("FlowScreenView: a flow that is not shown", () => {
  test("says that the flow was not found for an unknown name", () => {
    expect(render({ name: "missing" })).toContain("flowが見つかりません");
  });

  test("draws no diagram for an unknown name", () => {
    expect(render({ name: "missing" })).not.toContain("<svg");
  });

  test("says that the flow was not found for an unsafe name", () => {
    expect(render({ name: "../x" })).toContain("flowが見つかりません");
  });

  test("does not write the unsafe name into the page", () => {
    expect(render({ name: "../x" })).not.toContain("../x");
  });

  test("says that the data could not be read when there is no data", () => {
    expect(render({ data: null })).toContain(
      "flowの図のデータを読み込めませんでした",
    );
  });
});
