import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { StepViewData } from "../../../api/jobsQueries.ts";
import { FLOW_GRAPH } from "../../../lib/flowGraphData.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";
import { ItemFlowProgressView } from "./ItemFlowProgress.tsx";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const WIDE = 900;
const NARROW = 400;

function step(
  id: string,
  state: string,
  skipped = false,
  jobId: string | null = null,
): StepViewData {
  return { id, state, job_id: jobId, iterations: null, skipped };
}

function steps(
  list: readonly StepViewData[],
  overrides: Partial<Extract<FlowProgressView, { kind: "steps" }>> = {},
): FlowProgressView {
  return {
    kind: "steps",
    jobId: JOB,
    flowPath: "f/factory/pipeline",
    jobState: "running",
    steps: list,
    stale: false,
    ...overrides,
  };
}

function render(
  view: FlowProgressView,
  options: { kind?: string; width?: number } = {},
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ItemFlowProgressView
        kind={options.kind ?? "issue"}
        graph={FLOW_GRAPH}
        view={view}
        width={options.width ?? WIDE}
      />
    </MemoryRouter>,
  );
}

describe("workItemFlowProgress: the path", () => {
  test("shows the path of the work item kind as a diagram", () => {
    expect(render({ kind: "none" })).toContain("作業項目の経路の図");
  });

  test("shows no highlight when flow_job_id is null", () => {
    expect(render({ kind: "none" })).not.toContain("実行中");
  });

  test("shows no steps when flow_job_id is null", () => {
    expect(render({ kind: "none" })).not.toContain("<ol");
  });

  test("draws nothing for a kind without a path when there is no progress", () => {
    expect(render({ kind: "none" }, { kind: "brand_new" })).toBe("");
  });

  test("shows the flows of the kind and not those of other kinds", () => {
    expect(render({ kind: "none" }, { kind: "pr_review" })).not.toContain(
      "pipeline",
    );
  });

  test("falls back to a list of the flows below 640px", () => {
    expect(render({ kind: "none" }, { width: NARROW })).not.toContain("<svg");
  });

  test("scrolls inside a focusable region when the diagram does not fit", () => {
    expect(render({ kind: "none" }, { width: 660 })).toContain('role="region"');
  });
});

describe("workItemFlowProgress: the current flow", () => {
  test("highlights the flow that the job runs", () => {
    expect(render(steps([step("prepare", "running")]))).toContain("実行中");
  });

  test("names the flow of the job above its steps", () => {
    expect(render(steps([step("prepare", "running")]))).toContain(
      "pipelineのステップ",
    );
  });

  test("lists the steps in the order the server returned them", () => {
    const html = render(
      steps([step("zeta", "success"), step("alpha", "running")]),
    );
    expect(html.indexOf("zeta")).toBeLessThan(html.indexOf("alpha"));
  });

  test("names a skipped step with the same word as the job detail", () => {
    expect(render(steps([step("gate", "success", true)]))).toContain(
      "スキップ",
    );
  });

  test("links a step to its job when the step has one", () => {
    expect(render(steps([step("prepare", "success", false, JOB)]))).toContain(
      `/jobs/${JOB}`,
    );
  });

  test("shows the steps of a job that has finished, without a highlight", () => {
    expect(
      render(steps([step("prepare", "success")], { jobState: "success" })),
    ).not.toContain("実行中");
  });

  test("shows the state of the job that the steps belong to", () => {
    expect(
      render(steps([step("prepare", "success")], { jobState: "success" })),
    ).toContain("成功");
  });

  test("shows a note instead of a list when the job has no step yet", () => {
    expect(render(steps([], { jobState: "queued" }))).not.toContain("<ol");
  });
});

describe("workItemFlowProgress: a failed read", () => {
  test("shows 前の値 when the detail read fails", () => {
    expect(
      render(steps([step("prepare", "running")], { stale: true })),
    ).toContain("前の値");
  });

  test("does not show 前の値 when the read succeeds", () => {
    expect(render(steps([step("prepare", "running")]))).not.toContain("前の値");
  });

  test("says the progress could not be read when there is no value", () => {
    expect(render({ kind: "unreadable" })).toContain("進行を読めませんでした");
  });
});
