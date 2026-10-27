import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { StepViewData } from "../../../api/jobsQueries.ts";
import { FLOW_GRAPH } from "../../../lib/flowGraphData.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";
import { ItemFlowProgressView } from "./ItemFlowProgress.tsx";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const STEP_JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const WIDE = 900;
const NARROW = 400;

/** 実行中のflowの箱の面と枠。図のノード側の強調の印である。 */
const HIGHLIGHT = "fill-selected stroke-primary";

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

function countOf(html: string, word: string): number {
  return html.split(word).length - 1;
}

describe("workItemFlowProgress: the path", () => {
  test("shows the path of the work item kind as a diagram", () => {
    expect(render({ kind: "none" })).toContain("作業項目の経路の図");
  });

  test("shows no highlight when flow_job_id is null", () => {
    expect(render({ kind: "none" })).not.toContain(HIGHLIGHT);
  });

  test("shows no steps when flow_job_id is null", () => {
    expect(render({ kind: "none" })).not.toContain("<ol");
  });

  test("draws nothing for a kind without a path when there is no progress", () => {
    expect(render({ kind: "none" }, { kind: "brand_new" })).toBe("");
  });

  test.each(["pr_review", "pr_fix", "audit", "dependabot"])(
    "draws nothing for %s, whose path is a single flow, when there is no progress",
    (kind) => {
      expect(render({ kind: "none" }, { kind })).toBe("");
    },
  );

  test("shows only the steps for a kind whose path is a single flow", () => {
    const html = render(
      steps([step("review", "running")], {
        flowPath: "f/factory/pr_review",
      }),
      { kind: "pr_review" },
    );
    expect(html).not.toContain("<svg");
  });

  test("still shows the steps for a kind whose path is a single flow", () => {
    const html = render(
      steps([step("review", "running")], {
        flowPath: "f/factory/pr_review",
      }),
      { kind: "pr_review" },
    );
    expect(html).toContain("pr_reviewのステップ");
  });

  test("shows the flows of the kind and not those of other kinds", () => {
    expect(render({ kind: "none" })).not.toContain("pr_review");
  });

  test("falls back to a list of the flows below 640px", () => {
    expect(render({ kind: "none" }, { width: NARROW })).not.toContain("<svg");
  });

  test("scrolls inside a focusable region when the diagram does not fit", () => {
    expect(render({ kind: "none" }, { width: 660 })).toContain('role="region"');
  });

  test("does not link an idle flow to the history of every work item", () => {
    expect(render({ kind: "none" })).not.toContain("tab=history");
  });
});

describe("workItemFlowProgress: the current flow", () => {
  test("highlights the flow that the job runs on the node of the diagram", () => {
    expect(render(steps([step("prepare", "running")]))).toContain(HIGHLIGHT);
  });

  test("marks the running flow with a mark that screen readers skip", () => {
    expect(render(steps([step("prepare", "running")]))).toContain(
      'aria-hidden="true" points=',
    );
  });

  test("opens the running job from the node of the flow", () => {
    const html = render(steps([step("prepare", "running")]));
    expect(html).toMatch(new RegExp(`<a [^>]*href="/jobs/${JOB}"[^>]*><rect`));
  });

  test("shows a queued flow as waiting, without the frame of a running one", () => {
    expect(render(steps([], { jobState: "queued" })).includes(HIGHLIGHT)).toBe(
      false,
    );
  });

  test("does not link the node of a queued flow to the history of every work item", () => {
    expect(render(steps([], { jobState: "queued" }))).not.toContain(
      "tab=history",
    );
  });

  test("names the flow of the job above its steps", () => {
    expect(render(steps([step("prepare", "running")]))).toContain(
      "pipelineのステップ",
    );
  });

  test("opens the job of flow_job_id from the heading of the steps", () => {
    const html = render(
      steps([step("review", "running")], { flowPath: "f/factory/pr_review" }),
      { kind: "pr_review" },
    );
    expect(html).toContain(`href="/jobs/${JOB}"`);
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
    expect(
      render(steps([step("prepare", "success", false, STEP_JOB)])),
    ).toContain(`href="/jobs/${STEP_JOB}"`);
  });

  test("says the running state once, on the node, when the diagram is shown", () => {
    expect(countOf(render(steps([step("prepare", "running")])), "実行中")).toBe(
      1,
    );
  });

  test("says the running state on the heading when there is no diagram", () => {
    expect(
      render(
        steps([step("review", "running")], {
          flowPath: "f/factory/pr_review",
        }),
        { kind: "pr_review" },
      ),
    ).toContain("実行中");
  });

  test("shows the state of a failed job on the heading, next to the diagram", () => {
    expect(
      render(steps([step("prepare", "failure")], { jobState: "failure" })),
    ).toContain("失敗");
  });

  test("does not highlight the flow of a failed job", () => {
    expect(
      render(steps([step("prepare", "failure")], { jobState: "failure" })),
    ).not.toContain(HIGHLIGHT);
  });

  test("shows a note instead of a list when the job has no step yet", () => {
    expect(render(steps([], { jobState: "queued" }))).toContain(
      "ステップはまだありません。",
    );
  });
});

describe("workItemFlowProgress: a failed read", () => {
  test("shows 前の値 when the detail read fails", () => {
    expect(
      render(steps([step("prepare", "running")], { stale: true })),
    ).toContain("前の値");
  });

  test("marks the diagram too as the previous value", () => {
    expect(
      countOf(
        render(steps([step("prepare", "running")], { stale: true })),
        "前の値",
      ),
    ).toBe(2);
  });

  test("marks the steps once when there is no diagram", () => {
    expect(
      countOf(
        render(
          steps([step("review", "running")], {
            flowPath: "f/factory/pr_review",
            stale: true,
          }),
          { kind: "pr_review" },
        ),
        "前の値",
      ),
    ).toBe(1);
  });

  test("does not show 前の値 when the read succeeds", () => {
    expect(render(steps([step("prepare", "running")]))).not.toContain("前の値");
  });

  test("says the progress could not be read when there is no value", () => {
    expect(render({ kind: "unreadable" })).toContain("進行を読めませんでした");
  });
});
