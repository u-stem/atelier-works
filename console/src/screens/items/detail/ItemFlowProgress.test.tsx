import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { StepViewData } from "../../../api/jobsQueries.ts";
import { FLOWS_DATA, type FlowsData } from "../../../lib/flowsData.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";
import { ItemFlowProgressView } from "./ItemFlowProgress.tsx";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const STEP_JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const WIDE = 900;
const NARROW = 400;

/** 実行中のステップの箱の面と枠。 */
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
  options: { width?: number; data?: FlowsData | null } = {},
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ItemFlowProgressView
        view={view}
        data={"data" in options ? (options.data ?? null) : FLOWS_DATA}
        width={options.width ?? WIDE}
      />
    </MemoryRouter>,
  );
}

/** 図(role="group"のsvg)の部分だけ。見出しの語と見分けるために使う。 */
function diagramOf(html: string): string {
  const start = html.indexOf('role="group"');
  return html.slice(start, html.indexOf("</svg>", start));
}

function countOf(html: string, word: string): number {
  return html.split(word).length - 1;
}

describe("ItemFlowProgressView: when there is nothing to show", () => {
  test("draws nothing when flow_job_id is null or the job ended well", () => {
    expect(render({ kind: "none" })).toBe("");
  });

  test("says the progress could not be read when there is no value", () => {
    expect(render({ kind: "unreadable" })).toContain("進行を読めませんでした");
  });

  test("draws no diagram when the progress could not be read", () => {
    expect(render({ kind: "unreadable" })).not.toContain('role="group"');
  });

  test("shows no step when the progress could not be read", () => {
    expect(render({ kind: "unreadable" })).not.toContain("のステップ");
  });
});

describe("ItemFlowProgressView: a running job", () => {
  const running = steps([
    step("prepare", "success"),
    step("generate", "running", false, STEP_JOB),
  ]);

  test("draws the diagram of the flow the job runs", () => {
    expect(render(running)).toContain('role="group" aria-label="pipelineの図"');
  });

  test("highlights the running step", () => {
    expect(render(running)).toContain(HIGHLIGHT);
  });

  test("marks the running step with a mark that screen readers skip", () => {
    expect(render(running)).toContain('aria-hidden="true" points=');
  });

  test("links a step to its child job", () => {
    expect(render(running)).toContain(`href="/jobs/${STEP_JOB}"`);
  });

  test("names the flow of the job above the diagram", () => {
    expect(render(running)).toContain("pipelineのステップ");
  });

  test("opens the job of flow_job_id from the heading", () => {
    expect(render(running)).toContain(`href="/jobs/${JOB}"`);
  });

  test("says the running state once, in the step, when the diagram is shown", () => {
    expect(countOf(render(running), "実行中")).toBe(1);
  });

  test("marks a conditional step, because a job overlays", () => {
    expect(render(running)).toContain("条件で飛ぶ");
  });

  test("names a skipped step with the same word as the job detail", () => {
    expect(render(steps([step("generate", "success", true)]))).toContain(
      "スキップ",
    );
  });

  test("does not link the diagram to the history of every work item", () => {
    expect(render(running)).not.toContain("tab=history");
  });
});

describe("ItemFlowProgressView: a job that is waiting or stopped", () => {
  test("draws the diagram of a queued job without the frame of a running step", () => {
    expect(render(steps([], { jobState: "queued" })).includes(HIGHLIGHT)).toBe(
      false,
    );
  });

  test("still draws the diagram of a queued job that has no step yet", () => {
    expect(render(steps([], { jobState: "queued" }))).toContain('role="group"');
  });

  test("shows the state of a failed job on the heading", () => {
    expect(
      render(steps([step("prepare", "success")], { jobState: "failure" })),
    ).toContain("失敗");
  });

  test("shows the failed step in the diagram, apart from the heading", () => {
    expect(
      diagramOf(
        render(steps([step("generate", "failure")], { jobState: "failure" })),
      ),
    ).toContain("失敗");
  });

  test("marks the failed step with the mark of a failure", () => {
    expect(
      render(steps([step("generate", "failure")], { jobState: "failure" })),
    ).toContain("stroke-failure");
  });

  test("does not highlight a failed step as a running one", () => {
    expect(
      render(steps([step("generate", "failure")], { jobState: "failure" })),
    ).not.toContain(HIGHLIGHT);
  });

  test("shows the state of a canceled job on the heading", () => {
    expect(
      render(steps([step("generate", "canceled")], { jobState: "canceled" })),
    ).toContain("取消");
  });

  test("shows the canceled step in the diagram, apart from the heading", () => {
    expect(
      diagramOf(
        render(steps([step("generate", "canceled")], { jobState: "canceled" })),
      ),
    ).toContain("取消");
  });

  test("shows the waiting state of a queued job on the heading when no step runs", () => {
    expect(render(steps([], { jobState: "queued" }))).toContain("待ち");
  });

  test("shows the running state on the heading when the steps only wait", () => {
    expect(
      render(steps([step("prepare", "waiting")], { jobState: "running" })),
    ).toContain("実行中");
  });

  test("hides the state on the heading when a step runs in the diagram", () => {
    expect(
      countOf(
        render(steps([step("generate", "running")], { jobState: "running" })),
        "実行中",
      ),
    ).toBe(1);
  });
});

describe("ItemFlowProgressView: a failed read", () => {
  test("shows 前の値 when the detail read fails", () => {
    expect(
      render(steps([step("prepare", "running")], { stale: true })),
    ).toContain("前の値");
  });

  test("shows 前の値 once, above the diagram", () => {
    const html = render(steps([step("prepare", "running")], { stale: true }));

    expect([
      countOf(html, "前の値"),
      html.indexOf("前の値") < html.indexOf("<svg"),
    ]).toEqual([1, true]);
  });

  test("does not show 前の値 when the read succeeds", () => {
    expect(render(steps([step("prepare", "running")]))).not.toContain("前の値");
  });
});

describe("ItemFlowProgressView: the width", () => {
  const running = steps([step("prepare", "running")]);

  test("falls back to a list below 640px", () => {
    expect(render(running, { width: NARROW })).not.toContain('role="group"');
  });

  test("lists the steps in order below 640px", () => {
    expect(render(running, { width: NARROW })).toContain(
      'aria-label="pipelineのステップ"',
    );
  });

  test("scrolls inside a focusable region when the diagram does not fit", () => {
    expect(render(running, { width: 660 })).toContain('role="region"');
  });

  test("draws neither the diagram nor the list before the width is measured", () => {
    expect(render(running, { width: 0 })).not.toContain("入口");
  });

  test("keeps the heading before the width is measured", () => {
    expect(render(running, { width: 0 })).toContain("pipelineのステップ");
  });
});

describe("ItemFlowProgressView: the diagram of the work item", () => {
  const BODY = 760;

  test("draws no entry of the flow", () => {
    expect(
      render(steps([step("prepare", "running")]), { width: WIDE }),
    ).not.toContain("スケジュール");
  });

  test("adds no note about the conditional edges", () => {
    expect(
      render(steps([step("prepare", "running")]), { width: WIDE }),
    ).not.toContain("起動しない場合があります");
  });

  test("fits implement in the body of the page without scrolling", () => {
    expect(
      render(
        steps([step("implement_prepare", "running")], {
          flowPath: "f/factory/implement",
        }),
        { width: BODY },
      ),
    ).not.toContain('role="region"');
  });

  test("scrolls pr_fix in the body of the page", () => {
    expect(
      render(
        steps([step("pr_fix_prepare", "running")], {
          flowPath: "f/factory/pr_fix",
        }),
        { width: BODY },
      ),
    ).toContain('role="region"');
  });
});

describe("ItemFlowProgressView: steps the definition lacks", () => {
  test("puts them after the diagram", () => {
    const html = render(
      steps([step("prepare", "success"), step("old_step", "failure")], {
        jobState: "failure",
      }),
    );

    expect(html.indexOf("old_step")).toBeGreaterThan(html.indexOf("</svg>"));
  });

  test("says they are not in the definition", () => {
    expect(
      render(steps([step("old_step", "failure")], { jobState: "failure" })),
    ).toContain("定義に無いステップ");
  });
});

describe("ItemFlowProgressView: a flow that is not in the data", () => {
  const other = steps([step("review", "running")], {
    flowPath: "f/factory/unknown_flow",
  });

  test("falls back to the list of steps", () => {
    expect(render(other)).toContain("<ol");
  });

  test("writes the id of the step in the fallback", () => {
    expect(render(other)).toContain("review");
  });

  test("draws no diagram for the unknown flow", () => {
    expect(render(other)).not.toContain('role="group"');
  });

  test("names the flow in the heading of the fallback", () => {
    expect(render(other)).toContain("unknown_flowのステップ");
  });

  test("shows the state of the job on the heading of the fallback", () => {
    expect(render(other)).toContain("実行中");
  });

  test("says there is no step yet in the fallback", () => {
    expect(render(steps([], { flowPath: "f/factory/unknown_flow" }))).toContain(
      "ステップはまだありません。",
    );
  });

  test("falls back too when the bundled data could not be read", () => {
    expect(
      render(steps([step("prepare", "running")]), { data: null }),
    ).toContain("<ol");
  });

  test("shows 前の値 once in the fallback", () => {
    expect(
      countOf(
        render(
          steps([step("review", "running")], {
            flowPath: "f/factory/unknown_flow",
            stale: true,
          }),
        ),
        "前の値",
      ),
    ).toBe(1);
  });
});
