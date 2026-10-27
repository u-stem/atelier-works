import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobListView, JobSummaryView } from "../../api/jobsQueries.ts";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { flowGraphStateOf } from "../../lib/flowOverlay.ts";
import { FlowGraphBody, FlowGraphSection } from "./FlowGraphSection.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const GRAPH: FlowGraph = {
  nodes: [{ id: "flow:pipeline", kind: "flow", label: "pipeline", note: "" }],
  edges: [],
};

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

const RUNNING: JobSummaryView = {
  id: ID,
  state: "running",
  script_path: "f/factory/pipeline",
  job_kind: "flow",
  created_at: "2026-10-26T05:00:00.000000Z",
  started_at: "2026-10-26T05:00:01.000000Z",
  completed_at: null,
  scheduled_for: null,
  duration_ms: null,
  schedule_path: null,
  parent_job: null,
  tag: "flow",
  is_flow_step: false,
};

const ACTIVE: JobListView = {
  view: "active",
  jobs: [RUNNING],
  next_before: null,
  filter_rejected: false,
  truncated: false,
};

const READ_SCHEDULES = { data: undefined, isError: false };

describe("FlowGraphSection", () => {
  test("has a heading for the section", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toContain("起動の関係");
  });

  test("draws the graph as an svg once it is opened", () => {
    expect(render(<FlowGraphSection graph={GRAPH} initiallyOpen />)).toContain(
      'aria-label="起動の関係の図"',
    );
  });

  test("does not use the isolated frame for the graph", () => {
    expect(
      render(<FlowGraphSection graph={GRAPH} initiallyOpen />),
    ).not.toContain("<iframe");
  });

  test("does not draw the graph while it is folded", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).not.toContain(
      'aria-label="起動の関係の図"',
    );
  });

  test("folds the graph", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toMatch(
      /<details(?![^>]* open)/,
    );
  });

  test("stays closed on a jump, since no chip leads here", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).not.toContain(
      "data-jump-open",
    );
  });

  test("can start open", () => {
    expect(render(<FlowGraphSection graph={GRAPH} initiallyOpen />)).toMatch(
      /<details[^>]* open/,
    );
  });

  test("lets a heading link land on the heading", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toMatch(
      /<h2 id="flow-graph-heading" tabindex="-1"/,
    );
  });

  test("is wide enough for the layout", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toMatch(
      /<section[^>]*class="[^"]*max-w-6xl/,
    );
  });

  test("explains the arrows", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toContain("破線");
  });

  test("says that a launch from one script to another is not drawn", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toContain(
      "scriptからscriptの起動は含みません",
    );
  });

  test("explains that running flows are marked", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).toContain(
      "実行中のflowは強調し",
    );
  });

  test("no longer says that the state of the runs is not shown", () => {
    expect(render(<FlowGraphSection graph={GRAPH} />)).not.toContain(
      "実行の状態は示しません",
    );
  });

  test("says so when the data cannot be read", () => {
    expect(render(<FlowGraphSection graph={null} />)).toContain(
      "起動の関係のデータを読み込めませんでした",
    );
  });

  test("does not draw the graph when the data cannot be read", () => {
    expect(render(<FlowGraphSection graph={null} />)).not.toContain("<svg");
  });
});

describe("systemFlowGraph", () => {
  const failed = {
    active: { data: ACTIVE, isError: true },
    schedules: READ_SCHEDULES,
  };

  test("shows a failure note and drops the highlight when the active read fails", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf(failed)}
          width={1200}
        />,
      ),
    ).toContain("実行の状態を読めませんでした");
  });

  test("marks nothing running when the active read fails", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf(failed)}
          width={1200}
        />,
      ),
    ).not.toContain("実行中");
  });

  test("shows no failure note when the read worked", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf({
            active: { data: ACTIVE, isError: false },
            schedules: READ_SCHEDULES,
          })}
          width={1200}
        />,
      ),
    ).not.toContain("読めませんでした");
  });

  test("marks the running flow when the read worked", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf({
            active: { data: ACTIVE, isError: false },
            schedules: READ_SCHEDULES,
          })}
          width={1200}
        />,
      ),
    ).toContain("実行中");
  });

  test("says apart that the results of the schedules could not be read", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf({
            active: { data: ACTIVE, isError: false },
            schedules: { data: undefined, isError: true },
          })}
          width={1200}
        />,
      ),
    ).toContain("定期の入口の直近の結果を読めませんでした");
  });
});

describe("flowGraphSection", () => {
  const state = flowGraphStateOf(undefined);

  test("draws the svg as it is when the section is as wide as the layout", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={1080} />),
    ).toMatch(/<svg/);
  });

  test("has no scroll region when the layout fits", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={1152} />),
    ).not.toContain('role="region"');
  });

  test("scrolls inside a focusable region between 640px and the layout width", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={900} />),
    ).toMatch(/<div(?=[^>]*role="region")(?=[^>]*tabindex="0")[^>]*>/);
  });

  test("names the scroll region", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={900} />),
    ).toMatch(
      /role="region"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*role="region"/,
    );
  });

  test("keeps the svg inside the scroll region at 640px", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={640} />),
    ).toMatch(/role="region"[\s\S]*<svg/);
  });

  test("falls back to a list below 640px", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={639} />),
    ).toMatch(/^(?![\s\S]*<svg)[\s\S]*pipeline/);
  });

  test("has no scroll region in the list", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={400} />),
    ).not.toContain('role="region"');
  });
});
