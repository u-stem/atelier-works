import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import type {
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../api/jobsQueries.ts";
import type { Box, Point } from "./flowDiagram.ts";
import {
  FLOWS_DATA,
  type FlowDefinition,
  type FlowExit,
  type FlowsData,
} from "./flowsData.ts";
import {
  footNotes,
  initialExpanded,
  layoutOriginGraph,
  NODE_WIDTH,
  type OriginGraphModel,
  originDiagramLabel,
  originGraphModel,
  originRunView,
} from "./originGraph.ts";

function realData(): FlowsData {
  if (FLOWS_DATA === null) throw new Error("flows.json is unreadable");
  return FLOWS_DATA;
}

function realModel(name: string): OriginGraphModel {
  const model = originGraphModel(realData(), name);
  if (model === null) throw new Error(`no schedule ${name}`);
  return model;
}

function flow(
  name: string,
  exits: readonly FlowExit[] = [],
  stepIds: readonly string[] = ["prepare", "finish"],
): FlowDefinition {
  return {
    name,
    summary: `${name}の概要`,
    description: "",
    steps: stepIds.map((id) => ({
      id,
      summary: `${id}の説明`,
      scriptPath: `f/factory/steps/${id}`,
      conditional: false,
    })),
    entries: [{ kind: "human", label: "人" }],
    unwiredEntries: [],
    exits,
  };
}

function exit(flowName: string, via: FlowExit["via"], step = "finish") {
  return { flow: flowName, step, via };
}

function synthetic(
  flows: readonly FlowDefinition[],
  scheduleFlows: readonly string[],
): FlowsData {
  return {
    flows,
    schedules: [{ name: "origin", summary: "起点", flows: scheduleFlows }],
  };
}

function syntheticModel(
  flows: readonly FlowDefinition[],
  scheduleFlows: readonly string[],
): OriginGraphModel {
  const model = originGraphModel(synthetic(flows, scheduleFlows), "origin");
  if (model === null) throw new Error("no schedule origin");
  return model;
}

function columnsOf(model: OriginGraphModel): Record<string, number> {
  return Object.fromEntries(
    model.nodes.map((node) => [node.flow.name, node.column]),
  );
}

function edgesOf(model: OriginGraphModel) {
  return model.edges.map(
    (edge) => `${edge.from ?? "origin"}>${edge.to} ${edge.via} ${edge.span}`,
  );
}

function notesOf(model: OriginGraphModel, name: string): string[] {
  const node = model.nodes.find((candidate) => candidate.flow.name === name);
  return node === undefined ? [] : footNotes(node).map((note) => note.text);
}

describe("originGraphModel with the real data", () => {
  test("returns null for a schedule that is not in the data", () => {
    expect(originGraphModel(realData(), "missing")).toBeNull();
  });

  test("puts poll_issues in three flow columns after the origin", () => {
    expect(columnsOf(realModel("poll_issues"))).toEqual({
      pipeline: 1,
      design: 2,
      implement: 3,
    });
  });

  test("counts the origin among the columns", () => {
    expect(realModel("poll_issues").columns).toBe(4);
  });

  test("draws the approval that skips a column of poll_issues as a line", () => {
    expect(edgesOf(realModel("poll_issues"))).toEqual([
      "origin>pipeline launch 1",
      "pipeline>design approve 1",
      "pipeline>implement approve 2",
      "design>implement approve 1",
    ]);
  });

  test("gives the origin of poll_issues its name and summary", () => {
    expect(realModel("poll_issues").origin.name).toBe("poll_issues");
  });

  test("puts the two flows of self_update side by side", () => {
    expect(columnsOf(realModel("self_update"))).toEqual({
      implement: 1,
      pr_fix: 1,
    });
  });

  test("launches both flows of self_update from the origin", () => {
    expect(edgesOf(realModel("self_update"))).toEqual([
      "origin>implement launch 1",
      "origin>pr_fix launch 1",
    ]);
  });

  test("puts the two flows of poll_prs side by side", () => {
    expect(columnsOf(realModel("poll_prs"))).toEqual({
      pr_fix: 1,
      pr_review: 1,
    });
  });

  test("launches a single flow of audit_kickoff", () => {
    expect(edgesOf(realModel("audit_kickoff"))).toEqual([
      "origin>audit launch 1",
    ]);
  });

  test("draws no flow for a schedule that launches nothing", () => {
    expect(realModel("cleanup_db").nodes).toEqual([]);
  });

  test("has only the origin column for a schedule that launches nothing", () => {
    expect(realModel("cleanup_db").columns).toBe(1);
  });

  test("notes the return of implement to design and to pipeline", () => {
    expect(notesOf(realModel("self_update"), "implement")).toEqual([
      "差し戻し: design",
      "差し戻し: pipeline",
    ]);
  });

  test("notes the return of pr_fix to design and to pipeline", () => {
    expect(notesOf(realModel("self_update"), "pr_fix")).toEqual([
      "差し戻し: design",
      "差し戻し: pipeline",
    ]);
  });

  test("gives one note per way back to the same flow", () => {
    expect(notesOf(realModel("poll_issues"), "design")).toEqual([
      "差し戻し: pipeline",
      "やり直し",
      "却下の後: pipeline",
    ]);
  });

  test("writes a note for a rejection that remakes the same flow", () => {
    expect(notesOf(realModel("poll_issues"), "pipeline")).toEqual(["やり直し"]);
  });

  test("keeps a flow that only a return reaches off the diagram", () => {
    expect(Object.keys(columnsOf(realModel("self_update")))).not.toContain(
      "design",
    );
  });

  test("marks a diagram with approvals as one that may not start a flow", () => {
    expect(realModel("poll_issues").conditional).toBe(true);
  });

  test("marks a diagram with no approval and no return as always starting", () => {
    expect(realModel("audit_kickoff").conditional).toBe(false);
  });

  test("keeps every schedule within four columns", () => {
    const wide = realData().schedules.filter(
      (schedule) => (realModel(schedule.name)?.columns ?? 0) > 4,
    );

    expect(wide).toEqual([]);
  });

  test("never writes a drawn exit as a note", () => {
    const wrong = realData().schedules.flatMap((schedule) =>
      realModel(schedule.name).nodes.flatMap((node) =>
        footNotes(node).filter(
          (note) => note.via === "launch" || note.via === "approve",
        ),
      ),
    );

    expect(wrong.filter((note) => !note.self)).toEqual([]);
  });

  test("draws every launch and approval of a flow on the diagram as a line", () => {
    const missing = realData().schedules.flatMap((schedule) => {
      const model = realModel(schedule.name);
      return model.nodes.flatMap((node) =>
        node.flow.exits
          .filter((item) => item.via === "launch" || item.via === "approve")
          .filter((item) => item.flow !== node.flow.name)
          .filter(
            (item) =>
              !model.edges.some(
                (edge) =>
                  edge.from === node.flow.name &&
                  edge.to === item.flow &&
                  edge.via === item.via,
              ),
          )
          .map((item) => `${schedule.name} ${node.flow.name}>${item.flow}`),
      );
    });

    expect(missing).toEqual([]);
  });
});

describe("originGraphModel with synthetic data", () => {
  test("stops at a cycle of forward edges and writes the closing edge as a note", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "launch")]),
        flow("b", [exit("c", "launch")]),
        flow("c", [exit("b", "launch")]),
      ],
      ["a"],
    );

    expect(notesOf(model, "c")).toEqual(["次に起動: b"]);
  });

  test("keeps the columns of a cycle of forward edges finite", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "launch")]),
        flow("b", [exit("c", "launch")]),
        flow("c", [exit("b", "launch")]),
      ],
      ["a"],
    );

    expect(columnsOf(model)).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("does not draw a return as a line", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "approve")]),
        flow("b", [exit("a", "reject"), exit("a", "rework")]),
      ],
      ["a"],
    );

    expect(edgesOf(model)).toEqual(["origin>a launch 1", "a>b approve 1"]);
  });

  test("writes each return as a note of its own", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "approve")]),
        flow("b", [exit("a", "reject"), exit("a", "rework")]),
      ],
      ["a"],
    );

    expect(notesOf(model, "b")).toEqual(["却下の後: a", "差し戻し: a"]);
  });

  test("puts a flow after the longest path to it", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "approve"), exit("c", "approve")]),
        flow("b", [exit("c", "launch")]),
        flow("c"),
      ],
      ["a"],
    );

    expect(columnsOf(model)).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("draws the edge that skips a column as a line with a span of two", () => {
    const model = syntheticModel(
      [
        flow("a", [exit("b", "approve"), exit("c", "approve")]),
        flow("b", [exit("c", "launch")]),
        flow("c"),
      ],
      ["a"],
    );

    expect(edgesOf(model)).toContain("a>c approve 2");
  });

  test("merges exits of the same way and target into one", () => {
    const model = syntheticModel(
      [
        flow("a", [
          exit("b", "approve", "prepare"),
          exit("b", "approve", "finish"),
        ]),
        flow("b"),
      ],
      ["a"],
    );

    expect(edgesOf(model)).toEqual(["origin>a launch 1", "a>b approve 1"]);
  });

  test("does not make a node of a flow that only a rework edge reaches", () => {
    const model = syntheticModel(
      [flow("a", [exit("z", "rework")]), flow("z")],
      ["a"],
    );

    expect(Object.keys(columnsOf(model))).toEqual(["a"]);
  });

  test("lists the flows of the schedule in the order of the data within a column", () => {
    const model = syntheticModel(
      [flow("a"), flow("b"), flow("c")],
      ["c", "a", "b"],
    );

    expect(model.nodes.map((node) => node.flow.name)).toEqual(["c", "a", "b"]);
  });
});

describe("initialExpanded", () => {
  test("opens the only flow of a schedule", () => {
    expect([...initialExpanded(realModel("audit_kickoff"))]).toEqual(["audit"]);
  });

  test("opens nothing when a schedule launches two flows", () => {
    expect([...initialExpanded(realModel("poll_prs"))]).toEqual([]);
  });

  test("opens nothing when a schedule launches no flow", () => {
    expect([...initialExpanded(realModel("cleanup_db"))]).toEqual([]);
  });

  test("opens the first flow of poll_issues, a single flow schedule", () => {
    expect([...initialExpanded(realModel("poll_issues"))]).toEqual([
      "pipeline",
    ]);
  });

  test("opens exactly the schedules that launch one flow", () => {
    const opened = realData()
      .schedules.filter(
        (schedule) => initialExpanded(realModel(schedule.name)).size > 0,
      )
      .map((schedule) => schedule.name)
      .sort();

    expect(opened).toEqual([
      "audit_kickoff",
      "auto_retry_pr_review",
      "poll_dependabot",
      "poll_issues",
      "watch_pr_ci",
      "watch_pr_conflicts",
    ]);
  });
});

function allFlowNames(model: OriginGraphModel): ReadonlySet<string> {
  return new Set(model.nodes.map((node) => node.flow.name));
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** 線の1区間が、箱の内側(縁から1px内)を通るか。 */
function crosses(from: Point, to: Point, box: Box): boolean {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)),
  );
  for (let index = 0; index <= steps; index += 1) {
    const x = from.x + ((to.x - from.x) * index) / steps;
    const y = from.y + ((to.y - from.y) * index) / steps;
    if (
      x > box.x + 1 &&
      x < box.x + box.width - 1 &&
      y > box.y + 1 &&
      y < box.y + box.height - 1
    ) {
      return true;
    }
  }
  return false;
}

const SCHEDULE_NAMES = [
  "poll_issues",
  "poll_prs",
  "self_update",
  "audit_kickoff",
  "poll_dependabot",
  "watch_pr_ci",
  "cleanup_db",
];

describe("layoutOriginGraph", () => {
  test.each(SCHEDULE_NAMES)(
    "keeps the width of every node of %s whether it is open or closed",
    (name) => {
      const model = realModel(name);
      const closed = layoutOriginGraph(model, new Set());
      const open = layoutOriginGraph(model, allFlowNames(model));

      expect(open.nodes.map((node) => node.width)).toEqual(
        closed.nodes.map(() => NODE_WIDTH),
      );
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps the width of the diagram of %s whether its nodes are open or closed",
    (name) => {
      const model = realModel(name);

      expect(layoutOriginGraph(model, allFlowNames(model)).width).toBe(
        layoutOriginGraph(model, new Set()).width,
      );
    },
  );

  test("makes a node taller when it opens", () => {
    const model = realModel("poll_prs");
    const closed = layoutOriginGraph(model, new Set());
    const open = layoutOriginGraph(model, new Set(["pr_fix"]));
    const height = (layout: typeof open) =>
      layout.nodes.find((node) => node.flow === "pr_fix")?.height ?? 0;

    expect(height(open)).toBeGreaterThan(height(closed));
  });

  test("gives an open node a row for each step in the order of the flow", () => {
    const model = realModel("poll_prs");
    const open = layoutOriginGraph(model, new Set(["pr_fix"]));
    const node = open.nodes.find((candidate) => candidate.flow === "pr_fix");
    const flowSteps = model.nodes.find((item) => item.flow.name === "pr_fix");

    expect(node?.steps.map((row) => row.id)).toEqual(
      flowSteps?.flow.steps.map((step) => step.id),
    );
  });

  test("gives a closed node no step rows and no link row", () => {
    const closed = layoutOriginGraph(realModel("poll_prs"), new Set());

    expect(
      closed.nodes.filter(
        (node) => node.steps.length > 0 || node.linkY !== null,
      ),
    ).toEqual([]);
  });

  test("gives an open node a row for the link to the diagram of the flow", () => {
    const open = layoutOriginGraph(
      realModel("audit_kickoff"),
      new Set(["audit"]),
    );

    expect(open.nodes[0]?.linkY).not.toBeNull();
  });

  test("stacks the nodes of a column from top to bottom without a gap that overlaps", () => {
    const model = realModel("poll_prs");
    const [first, second] = layoutOriginGraph(model, new Set()).nodes;

    expect((second?.y ?? 0) >= (first?.y ?? 0) + (first?.height ?? 0)).toBe(
      true,
    );
  });

  test.each(SCHEDULE_NAMES)(
    "keeps the boxes of %s apart when every node is closed",
    (name) => {
      const layout = layoutOriginGraph(realModel(name), new Set());
      const boxes: Box[] = [layout.origin, ...layout.nodes];
      const touching = boxes.flatMap((box, index) =>
        boxes.slice(index + 1).filter((other) => overlaps(box, other)),
      );

      expect(touching).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps the boxes of %s apart when every node is open",
    (name) => {
      const model = realModel(name);
      const layout = layoutOriginGraph(model, allFlowNames(model));
      const boxes: Box[] = [layout.origin, ...layout.nodes];
      const touching = boxes.flatMap((box, index) =>
        boxes.slice(index + 1).filter((other) => overlaps(box, other)),
      );

      expect(touching).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps every line of %s out of the boxes when every node is closed",
    (name) => {
      const layout = layoutOriginGraph(realModel(name), new Set());
      const boxes: Box[] = [layout.origin, ...layout.nodes];
      const through = layout.edges.flatMap((edge) =>
        edge.points.slice(1).flatMap((point, index) => {
          const from = edge.points[index];
          return from === undefined
            ? []
            : boxes.filter((box) => crosses(from, point, box));
        }),
      );

      expect(through).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps every line of %s out of the boxes when every node is open",
    (name) => {
      const model = realModel(name);
      const layout = layoutOriginGraph(model, allFlowNames(model));
      const boxes: Box[] = [layout.origin, ...layout.nodes];
      const through = layout.edges.flatMap((edge) =>
        edge.points.slice(1).flatMap((point, index) => {
          const from = edge.points[index];
          return from === undefined
            ? []
            : boxes.filter((box) => crosses(from, point, box));
        }),
      );

      expect(through).toEqual([]);
    },
  );

  test("draws a line for every forward edge", () => {
    const model = realModel("poll_issues");

    expect(
      layoutOriginGraph(model, new Set()).edges.map((e) => e.edge),
    ).toEqual([...model.edges]);
  });

  test("starts a line at the right side of its source and ends it at the left side of its target", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const wrong = layout.edges.filter((item) => {
      const source =
        item.edge.from === null
          ? layout.origin
          : layout.nodes.find((node) => node.flow === item.edge.from);
      const target = layout.nodes.find((node) => node.flow === item.edge.to);
      const start = item.points[0];
      const end = item.points[item.points.length - 1];
      return (
        source === undefined ||
        target === undefined ||
        start === undefined ||
        end === undefined ||
        start.x !== source.x + source.width ||
        end.x !== target.x
      );
    });

    expect(wrong).toEqual([]);
  });

  test("routes the line that skips a column below every box", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const skipping = layout.edges.find((item) => item.edge.span > 1);
    const bottom = Math.max(
      ...[layout.origin, ...layout.nodes].map((box) => box.y + box.height),
    );
    const lane = Math.max(...(skipping?.points.map((point) => point.y) ?? [0]));

    expect(lane).toBeGreaterThan(bottom);
  });

  test("keeps the diagram tall enough for the line that skips a column", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const skipping = layout.edges.find((item) => item.edge.span > 1);
    const lane = Math.max(...(skipping?.points.map((point) => point.y) ?? [0]));

    expect(layout.height).toBeGreaterThan(lane);
  });

  test("starts both approvals of the same step at the same point when closed", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const starts = layout.edges
      .filter((item) => item.edge.from === "pipeline")
      .map((item) => JSON.stringify(item.points[0]));

    expect(new Set(starts).size).toBe(1);
  });

  test("starts both approvals of the same step at the row of the step when open", () => {
    const model = realModel("poll_issues");
    const layout = layoutOriginGraph(model, new Set(["pipeline"]));
    const node = layout.nodes.find((item) => item.flow === "pipeline");
    const row = node?.steps.find((step) => step.id === "request_approval");
    const starts = layout.edges
      .filter((item) => item.edge.from === "pipeline")
      .map((item) => item.points[0]?.y);

    expect(starts).toEqual([
      (row?.y ?? 0) + (row?.height ?? 0) / 2,
      (row?.y ?? 0) + (row?.height ?? 0) / 2,
    ]);
  });

  test("starts a line from the header of a closed node", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const node = layout.nodes.find((item) => item.flow === "pipeline");
    const start = layout.edges.find((item) => item.edge.from === "pipeline")
      ?.points[0];

    expect(start?.y).toBe((node?.y ?? 0) + (node?.headerHeight ?? 0) / 2);
  });

  test("puts the word on the approval lines and on no other", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());

    expect(
      layout.edges.map((item) => `${item.edge.via} ${item.label !== null}`),
    ).toEqual(["launch false", "approve true", "approve true", "approve true"]);
  });

  test("places the columns from left to right in order", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());

    expect(layout.nodes.map((node) => node.x)).toEqual(
      [...layout.nodes.map((node) => node.x)].sort((a, b) => a - b),
    );
  });

  test("gives a node a row for each foot note below its header", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const node = layout.nodes.find((item) => item.flow === "design");

    expect(node?.notes.map((note) => note.text)).toEqual([
      "差し戻し: pipeline",
      "やり直し",
      "却下の後: pipeline",
    ]);
  });

  test("keeps every foot note inside its node", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());
    const outside = layout.nodes.filter((node) =>
      node.notes.some((note) => note.y > node.y + node.height),
    );

    expect(outside).toEqual([]);
  });

  test("keeps every box and line inside the diagram", () => {
    const model = realModel("poll_issues");
    const layout = layoutOriginGraph(model, allFlowNames(model));
    const outside = [layout.origin, ...layout.nodes].filter(
      (box) =>
        box.x + box.width > layout.width || box.y + box.height > layout.height,
    );

    expect(outside).toEqual([]);
  });

  test("lays out the origin alone when a schedule launches no flow", () => {
    const layout = layoutOriginGraph(realModel("cleanup_db"), new Set());

    expect(layout.nodes).toEqual([]);
  });
});

describe("originDiagramLabel", () => {
  test("names the diagram after the schedule", () => {
    expect(originDiagramLabel("poll_prs")).toBe("poll_prsの起動の図");
  });
});

const PATH = "f/factory/poll_prs";
const NOW = Date.parse("2026-10-26T05:10:00.000Z");

function row(overrides: Partial<ScheduleViewData> = {}): ScheduleViewData {
  return {
    path: PATH,
    script_path: PATH,
    is_flow: false,
    schedule: "0 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    summary: null,
    paused_until: null,
    edited_at: null,
    error: null,
    next_run_at: null,
    recent_runs: [{ job_id: "job-1", success: true, duration_ms: 1000 }],
    definition: "matches",
    differences: [],
    ...overrides,
  };
}

function snapshot(
  schedules: readonly ScheduleViewData[],
  missing: readonly string[] = [],
): SchedulesSnapshotView {
  return { schedules, missing_in_workspace: missing, truncated: false };
}

function runOf(
  data: SchedulesSnapshotView | undefined,
  options: { isError?: boolean; error?: unknown } = {},
) {
  return originRunView(
    { data, isError: options.isError ?? false, error: options.error ?? null },
    "poll_prs",
    NOW,
  );
}

describe("originRunView", () => {
  test("says loading while there is no value and no failure", () => {
    expect(runOf(undefined)).toEqual({ kind: "loading" });
  });

  test("says the login is needed when the request was unauthorized", () => {
    expect(
      runOf(undefined, {
        isError: true,
        error: new ApiFailure({ kind: "unauthorized" }),
      }),
    ).toEqual({ kind: "login" });
  });

  test("says it failed when the request failed for another reason", () => {
    expect(
      runOf(undefined, {
        isError: true,
        error: new ApiFailure({ kind: "network" }),
      }),
    ).toEqual({ kind: "failed" });
  });

  test("says it failed for a failure that is not classified", () => {
    expect(
      runOf(undefined, { isError: true, error: new Error("boom") }),
    ).toEqual({ kind: "failed" });
  });

  test("says the schedule is missing when the workspace lacks the one the repository defines", () => {
    expect(runOf(snapshot([], [PATH]))).toEqual({ kind: "missing" });
  });

  test("says the schedule is missing when the snapshot has no row for it", () => {
    expect(runOf(snapshot([row({ path: "f/factory/other" })]))).toEqual({
      kind: "missing",
    });
  });

  test("does not take a row whose path only starts with the name", () => {
    expect(runOf(snapshot([row({ path: `${PATH}_x` })]))).toEqual({
      kind: "missing",
    });
  });

  test("reports a successful last run with no mark", () => {
    expect(runOf(snapshot([row()]))).toEqual({
      kind: "ready",
      lastRun: "success",
      marks: [],
    });
  });

  test("reports a failed last run", () => {
    expect(
      runOf(
        snapshot([
          row({
            recent_runs: [{ job_id: "j", success: false, duration_ms: 1 }],
          }),
        ]),
      ),
    ).toMatchObject({ lastRun: "failure" });
  });

  test("takes the first of the recent runs as the last one", () => {
    expect(
      runOf(
        snapshot([
          row({
            recent_runs: [
              { job_id: "a", success: false, duration_ms: 1 },
              { job_id: "b", success: true, duration_ms: 1 },
            ],
          }),
        ]),
      ),
    ).toMatchObject({ lastRun: "failure" });
  });

  test("reports no record when the schedule has not run", () => {
    expect(runOf(snapshot([row({ recent_runs: [] })]))).toMatchObject({
      lastRun: "none",
    });
  });

  test("marks a disabled schedule, so a success is not read as normal", () => {
    expect(runOf(snapshot([row({ enabled: false })]))).toMatchObject({
      marks: ["無効"],
    });
  });

  test("marks a schedule that is paused", () => {
    expect(
      runOf(snapshot([row({ paused_until: "2026-10-27T00:00:00.000Z" })])),
    ).toMatchObject({ marks: ["一時停止中"] });
  });

  test("does not mark a pause that has ended", () => {
    expect(
      runOf(snapshot([row({ paused_until: "2026-10-20T00:00:00.000Z" })])),
    ).toMatchObject({ marks: [] });
  });

  test("marks a schedule with an error", () => {
    expect(runOf(snapshot([row({ error: "bad cron" })]))).toMatchObject({
      marks: ["エラーあり"],
    });
  });

  test("keeps the value when the refetch failed", () => {
    expect(
      runOf(snapshot([row()]), {
        isError: true,
        error: new ApiFailure({ kind: "network" }),
      }).kind,
    ).toBe("ready");
  });
});
