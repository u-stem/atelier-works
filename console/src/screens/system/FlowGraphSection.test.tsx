import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobListView, JobSummaryView } from "../../api/jobsQueries.ts";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { flowGraphStateOf } from "../../lib/flowOverlay.ts";
import {
  FlowGraphBody,
  FlowGraphSection,
  FlowGraphSectionView,
} from "./FlowGraphSection.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-10-27T03:00:00Z");

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
          state={flowGraphStateOf(failed, NOW)}
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
          state={flowGraphStateOf(failed, NOW)}
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
          state={flowGraphStateOf(
            {
              active: { data: ACTIVE, isError: false },
              schedules: READ_SCHEDULES,
            },
            NOW,
          )}
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
          state={flowGraphStateOf(
            {
              active: { data: ACTIVE, isError: false },
              schedules: READ_SCHEDULES,
            },
            NOW,
          )}
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
          state={flowGraphStateOf(
            {
              active: { data: ACTIVE, isError: false },
              schedules: { data: undefined, isError: true },
            },
            NOW,
          )}
          width={1200}
        />,
      ),
    ).toContain("定期の入口の直近の結果を読めませんでした");
  });
});

describe("flowGraphSection", () => {
  const state = flowGraphStateOf(undefined, NOW);

  test("draws the svg as it is once the card around it fits too", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={1098} />),
    ).not.toContain('role="region"');
  });

  test("scrolls one pixel short of that, so the svg does not overflow the card", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={1097} />),
    ).toContain('role="region"');
  });

  test("scrolls at the width of the layout itself", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={state} width={1080} />),
    ).toContain('role="region"');
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

describe("the notes of a graph that was read in part", () => {
  const cut: JobListView = { ...ACTIVE, truncated: true };
  const stateOf = (active: JobListView, schedulesTruncated = false) =>
    flowGraphStateOf(
      {
        active: { data: active, isError: false },
        schedules: {
          data: {
            schedules: [],
            missing_in_workspace: [],
            truncated: schedulesTruncated,
          },
          isError: false,
        },
      },
      NOW,
    );

  test("says that a flow without a mark may still run when the queue was cut", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={stateOf(cut)} width={1200} />),
    ).toContain(
      "キューが切れているため、強調の無いflowも動いている場合があります",
    );
  });

  test("says that in the list too", () => {
    expect(
      render(<FlowGraphBody graph={GRAPH} state={stateOf(cut)} width={400} />),
    ).toContain("キューが切れているため");
  });

  test("does not say it when the queue was read to the end", () => {
    expect(
      render(
        <FlowGraphBody graph={GRAPH} state={stateOf(ACTIVE)} width={1200} />,
      ),
    ).not.toContain("キューが切れているため");
  });

  test("says that a schedule entry without a note may exist when the schedules were cut", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={stateOf(ACTIVE, true)}
          width={1200}
        />,
      ),
    ).toContain("scheduleを読み切れていないため");
  });

  test("does not say it in the list, which draws no schedule", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={stateOf(ACTIVE, true)}
          width={400}
        />,
      ),
    ).not.toContain("scheduleを読み切れていないため");
  });

  test("does not say that the results of the schedules could not be read in the list", () => {
    expect(
      render(
        <FlowGraphBody
          graph={GRAPH}
          state={flowGraphStateOf(
            {
              active: { data: ACTIVE, isError: false },
              schedules: { data: undefined, isError: true },
            },
            NOW,
          )}
          width={400}
        />,
      ),
    ).not.toContain("定期の入口の直近の結果を読めませんでした");
  });
});

describe("the summary above the graph", () => {
  const body = (reads: Parameters<typeof flowGraphStateOf>[0], width = 1200) =>
    render(
      <FlowGraphBody
        graph={GRAPH}
        state={flowGraphStateOf(reads, NOW)}
        width={width}
      />,
    );

  test("says it is reading while the active jobs have not arrived", () => {
    expect(
      body({
        active: { data: undefined, isError: false },
        schedules: READ_SCHEDULES,
      }),
    ).toContain("取得中");
  });

  test("says that no flow is running when none is", () => {
    expect(
      body({
        active: { data: { ...ACTIVE, jobs: [] }, isError: false },
        schedules: READ_SCHEDULES,
      }),
    ).toContain("いま動いているflowはありません");
  });

  test("counts the running flows", () => {
    expect(
      body({
        active: { data: ACTIVE, isError: false },
        schedules: READ_SCHEDULES,
      }),
    ).toContain("実行中 1・待ち 0");
  });

  test("keeps it in the list", () => {
    expect(
      body(
        {
          active: { data: { ...ACTIVE, jobs: [] }, isError: false },
          schedules: READ_SCHEDULES,
        },
        400,
      ),
    ).toContain("いま動いているflowはありません");
  });

  test("says nothing of the kind when the read failed", () => {
    expect(
      body({
        active: { data: undefined, isError: true },
        schedules: READ_SCHEDULES,
      }),
    ).not.toContain("いま動いているflowはありません");
  });
});

describe("the description by width", () => {
  const view = (width: number) =>
    render(
      <FlowGraphSectionView
        graph={GRAPH}
        width={width}
        nowMs={NOW}
        initiallyOpen
      />,
    );

  test("explains the arrows when the graph is drawn", () => {
    expect(view(1200)).toContain("破線");
  });

  test("explains the notes of the schedule entries when the graph is drawn", () => {
    expect(view(1200)).toContain("定期の入口には");
  });

  test("leaves the arrows out when only the list is shown", () => {
    expect(view(400)).not.toContain("破線");
  });

  test("leaves the schedule entries out when only the list is shown", () => {
    expect(view(400)).not.toContain("定期の入口には");
  });

  test("says what the list shows", () => {
    expect(view(400)).toContain("flowごと");
  });

  test("still names the section", () => {
    expect(view(400)).toContain("起動の関係");
  });
});
