import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import type {
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../api/jobsQueries.ts";
import type { Box, Point } from "./flowDiagram.ts";
import { wrapLines } from "./flowGraphFit.ts";
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
  NOTE_EM,
  type OriginGraphModel,
  type OriginLayout,
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

/** pr_fixの足の注記。どの起点の図でも同じ3行になる。 */
const PR_FIX_NOTES = [
  "差し戻し: design",
  "差し戻し: pipeline",
  "CI修正後の戻り: pr_review",
];

function notesOf(model: OriginGraphModel, name: string): string[] {
  const node = model.nodes.find((candidate) => candidate.flow.name === name);
  return node === undefined ? [] : footNotes(node).map((note) => note.text);
}

describe("originGraphModel with the real data", () => {
  test("returns null for a schedule that is not in the data", () => {
    expect(originGraphModel(realData(), "missing")).toBeNull();
  });

  test("puts poll_issues in five flow columns after the origin", () => {
    expect(columnsOf(realModel("poll_issues"))).toEqual({
      pipeline: 1,
      design: 2,
      implement: 3,
      pr_review: 4,
      pr_fix: 5,
    });
  });

  test("has six columns counting the origin for poll_issues", () => {
    expect(realModel("poll_issues").columns).toBe(6);
  });

  test("draws the approvals and the PR relations of poll_issues as lines", () => {
    expect(edgesOf(realModel("poll_issues"))).toEqual([
      "origin>pipeline launch 1",
      "pipeline>design approve 1",
      "pipeline>implement approve 2",
      "design>implement approve 1",
      "implement>pr_review pr 1",
      "pr_review>pr_fix pr 1",
    ]);
  });

  test("gives the origin of poll_issues its name and summary", () => {
    expect(realModel("poll_issues").origin.name).toBe("poll_issues");
  });

  test("chains implement, pr_review and pr_fix for self_update", () => {
    expect(columnsOf(realModel("self_update"))).toEqual({
      implement: 1,
      pr_review: 2,
      pr_fix: 3,
    });
  });

  test("draws the launches and the PR relations of self_update as lines", () => {
    expect(edgesOf(realModel("self_update"))).toEqual([
      "origin>implement launch 1",
      "origin>pr_fix launch 3",
      "implement>pr_review pr 1",
      "pr_review>pr_fix pr 1",
    ]);
  });

  test("puts pr_fix after pr_review for poll_prs", () => {
    expect(columnsOf(realModel("poll_prs"))).toEqual({
      pr_review: 1,
      pr_fix: 2,
    });
  });

  test("draws the launches and the PR relation of poll_prs as lines", () => {
    expect(edgesOf(realModel("poll_prs"))).toEqual([
      "origin>pr_fix launch 2",
      "origin>pr_review launch 1",
      "pr_review>pr_fix pr 1",
    ]);
  });

  test("adds pr_fix after pr_review for auto_retry_pr_review", () => {
    expect(edgesOf(realModel("auto_retry_pr_review"))).toEqual([
      "origin>pr_review launch 1",
      "pr_review>pr_fix pr 1",
    ]);
  });

  test("adds pr_fix after dependabot for poll_dependabot", () => {
    expect(edgesOf(realModel("poll_dependabot"))).toEqual([
      "origin>dependabot launch 1",
      "dependabot>pr_fix pr 1",
    ]);
  });

  test.each(["watch_pr_ci", "watch_pr_conflicts"])(
    "launches only pr_fix for %s and draws no pr_review box",
    (name) => {
      expect(edgesOf(realModel(name))).toEqual(["origin>pr_fix launch 1"]);
    },
  );

  test.each(["watch_pr_ci", "watch_pr_conflicts"])(
    "notes the return to pr_review for %s",
    (name) => {
      expect(notesOf(realModel(name), "pr_fix")).toEqual(PR_FIX_NOTES);
    },
  );

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

  test.each([
    "poll_issues",
    "poll_prs",
    "self_update",
    "auto_retry_pr_review",
    "poll_dependabot",
  ])("notes every way back of pr_fix in the diagram of %s", (name) => {
    expect(notesOf(realModel(name), "pr_fix")).toEqual(PR_FIX_NOTES);
  });

  test("gives pr_review no note when the diagram draws its exit as a line", () => {
    expect(notesOf(realModel("self_update"), "pr_review")).toEqual([]);
  });

  test("gives dependabot no note", () => {
    expect(notesOf(realModel("poll_dependabot"), "dependabot")).toEqual([]);
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

  test.each(["auto_retry_pr_review", "poll_dependabot"])(
    "marks the diagram of %s, which gains the returns of pr_fix",
    (name) => {
      expect(realModel(name).conditional).toBe(true);
    },
  );

  test.each(["pr", "pr_return"] as const)(
    "does not count a PR relation of the way %s as a condition",
    (via) => {
      const model = syntheticModel(
        [flow("a", [exit("b", via)]), flow("b")],
        ["a"],
      );

      expect(model.conditional).toBe(false);
    },
  );

  test("keeps every schedule within six columns counting the origin", () => {
    const wide = realData().schedules.filter(
      (schedule) => (realModel(schedule.name)?.columns ?? 0) > 6,
    );

    expect(wide).toEqual([]);
  });

  test("has at most one line that skips a column into the same flow", () => {
    const crowded = realData().schedules.flatMap((schedule) => {
      const into = new Map<string, number>();
      for (const edge of realModel(schedule.name).edges) {
        if (edge.span > 1) into.set(edge.to, (into.get(edge.to) ?? 0) + 1);
      }
      return [...into]
        .filter(([, count]) => count > 1)
        .map(([to]) => `${schedule.name}>${to}`);
    });

    expect(crowded).toEqual([]);
  });

  test("fits every foot note of every schedule in one line without the ellipsis", () => {
    const cut = realData().schedules.flatMap((schedule) =>
      realModel(schedule.name).nodes.flatMap((node) =>
        footNotes(node)
          .map((note) => note.text)
          .filter((text) => wrapLines(text, NOTE_EM, 1).join("") !== text),
      ),
    );

    expect(cut).toEqual([]);
  });

  test("never writes a drawn exit as a note", () => {
    const wrong = realData().schedules.flatMap((schedule) =>
      realModel(schedule.name).nodes.flatMap((node) =>
        footNotes(node).filter(
          (note) =>
            note.via === "launch" ||
            note.via === "approve" ||
            note.via === "pr",
        ),
      ),
    );

    expect(wrong.filter((note) => !note.self)).toEqual([]);
  });

  test("draws every launch, approval and PR relation of a flow on the diagram as a line", () => {
    const missing = realData().schedules.flatMap((schedule) => {
      const model = realModel(schedule.name);
      return model.nodes.flatMap((node) =>
        node.flow.exits
          .filter(
            (item) =>
              item.via === "launch" ||
              item.via === "approve" ||
              item.via === "pr",
          )
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

type Segment = readonly [Point, Point];

function segmentsOf(points: readonly Point[]): Segment[] {
  return points.slice(1).flatMap((point, index): Segment[] => {
    const from = points[index];
    return from === undefined ? [] : [[from, point]];
  });
}

/** 2つの線分が、同じ直線の上で長さのある区間を共有するか。 */
function sharesRun(a: Segment, b: Segment): boolean {
  const [a0, a1] = a;
  const [b0, b1] = b;
  const dx = a1.x - a0.x;
  const dy = a1.y - a0.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  const distance = (p: Point): number =>
    Math.abs(dx * (p.y - a0.y) - dy * (p.x - a0.x)) / length;
  if (distance(b0) > 0.5 || distance(b1) > 0.5) return false;
  const along = (p: Point): number =>
    ((p.x - a0.x) * dx + (p.y - a0.y) * dy) / length;
  const lo = Math.max(0, Math.min(along(b0), along(b1)));
  const hi = Math.min(length, Math.max(along(b0), along(b1)));
  return hi - lo > 0.5;
}

/**
 * 別々の線が共有する線分の組。同じ点から出る線の分かれ道(出口のステップが同じ)は、
 * 共通の出発点から始まる区間なので数えない。
 */
function sharedSegments(layout: OriginLayout): string[] {
  const found: string[] = [];
  layout.edges.forEach((a, index) => {
    for (const b of layout.edges.slice(index + 1)) {
      for (const sa of segmentsOf(a.points)) {
        for (const sb of segmentsOf(b.points)) {
          const branch = sa[0].x === sb[0].x && sa[0].y === sb[0].y;
          if (!branch && sharesRun(sa, sb)) {
            found.push(
              `${a.edge.from}->${a.edge.to} and ${b.edge.from}->${b.edge.to}`,
            );
          }
        }
      }
    }
  });
  return found;
}

/** データの全schedule。起動の図を持たないものも含める。 */
const SCHEDULE_NAMES = realData().schedules.map((schedule) => schedule.name);

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
    const model = syntheticModel(
      [
        flow("a", [exit("b", "launch"), exit("c", "launch")]),
        flow("b"),
        flow("c"),
      ],
      ["a"],
    );
    const layout = layoutOriginGraph(model, new Set(["b"]));
    const [, first, second] = layout.nodes;

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

  test.each(SCHEDULE_NAMES)(
    "keeps the lines of %s from sharing a run when every node is closed",
    (name) => {
      const layout = layoutOriginGraph(realModel(name), new Set());

      expect(sharedSegments(layout)).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps the lines of %s from sharing a run when every node is open",
    (name) => {
      const model = realModel(name);
      const layout = layoutOriginGraph(model, allFlowNames(model));

      expect(sharedSegments(layout)).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps the lines of %s from sharing a run in the initial state",
    (name) => {
      const model = realModel(name);
      const layout = layoutOriginGraph(model, initialExpanded(model));

      expect(sharedSegments(layout)).toEqual([]);
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

  test("puts the word on the approval lines and the PR lines only", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());

    expect(layout.edges.map((item) => `${item.edge.via} ${item.word}`)).toEqual(
      [
        "launch null",
        "approve 承認",
        "approve 承認",
        "approve 承認",
        "pr PR経由",
        "pr PR経由",
      ],
    );
  });

  test("places a label for every line that has a word", () => {
    const layout = layoutOriginGraph(realModel("poll_issues"), new Set());

    expect(
      layout.edges.map(
        (item) => (item.word !== null) === (item.label !== null),
      ),
    ).toEqual([true, true, true, true, true, true]);
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

/** 終点の矢じりを、線の終点で止まる12x12の矩形として扱う。 */
const ARROWHEAD = 12;

function arrowheadOf(points: readonly Point[]): Box {
  const end = points[points.length - 1] ?? { x: 0, y: 0 };
  return {
    x: end.x - ARROWHEAD,
    y: end.y - ARROWHEAD / 2,
    width: ARROWHEAD,
    height: ARROWHEAD,
  };
}

/** 線分が、矩形の内側(縁を含まない)を通るか。 */
function passesThrough(segment: Segment, box: Box): boolean {
  const [from, to] = segment;
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 4),
  );
  for (let index = 0; index <= steps; index += 1) {
    const x = from.x + ((to.x - from.x) * index) / steps;
    const y = from.y + ((to.y - from.y) * index) / steps;
    if (
      x > box.x &&
      x < box.x + box.width &&
      y > box.y &&
      y < box.y + box.height
    ) {
      return true;
    }
  }
  return false;
}

/** 開閉の全組み合わせと、初めの状態。 */
function expansions(model: OriginGraphModel): ReadonlySet<string>[] {
  const names = model.nodes.map((node) => node.flow.name);
  const all: ReadonlySet<string>[] = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    all.push(new Set(names.filter((_, index) => (mask >> index) & 1)));
  }
  return [...all, initialExpanded(model)];
}

describe("layoutOriginGraph arrowheads", () => {
  test.each(SCHEDULE_NAMES)(
    "keeps the arrowhead of a line that skips a column of %s clear of the other lines",
    (name) => {
      const model = realModel(name);
      const clashes = expansions(model).flatMap((expanded) => {
        const layout = layoutOriginGraph(model, expanded);
        return layout.edges.flatMap((item) => {
          if (item.edge.span <= 1) return [];
          const head = arrowheadOf(item.points);
          return layout.edges.flatMap((other) => {
            if (other === item) return [];
            const otherHead = arrowheadOf(other.points);
            const headsOverlap = overlaps(head, otherHead);
            const headMeetsLine = segmentsOf(other.points).some((segment) =>
              passesThrough(segment, head),
            );
            const lineMeetsHead = segmentsOf(item.points).some((segment) =>
              passesThrough(segment, otherHead),
            );
            return headsOverlap || headMeetsLine || lineMeetsHead
              ? [
                  `${[...expanded].join(",") || "closed"}: ${item.edge.from}->${item.edge.to} and ${other.edge.from}->${other.edge.to}`,
                ]
              : [];
          });
        });
      });

      expect(clashes).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "ends every line of %s within the header of its target",
    (name) => {
      const model = realModel(name);
      const outside = expansions(model).flatMap((expanded) => {
        const layout = layoutOriginGraph(model, expanded);
        return layout.edges.flatMap((item) => {
          const target = layout.nodes.find(
            (node) => node.flow === item.edge.to,
          );
          const end = item.points[item.points.length - 1];
          return target === undefined ||
            end === undefined ||
            (end.y >= target.y && end.y <= target.y + target.headerHeight)
            ? []
            : [`${item.edge.from}->${item.edge.to}`];
        });
      });

      expect(outside).toEqual([]);
    },
  );
});

/** 語の矩形。語は11pxで、中央に寄せて、基線の上に描く。幅は「PR経由」が収まる約40pxで見積もる。 */
function wordBoxOf(label: Point): Box {
  return { x: label.x - 20, y: label.y - 12, width: 40, height: 16 };
}

/** 語を持つ線と、その語の矩形。 */
function wordBoxes(layout: OriginLayout) {
  return layout.edges.flatMap((item) =>
    item.label === null ? [] : [{ item, box: wordBoxOf(item.label) }],
  );
}

describe("layoutOriginGraph words", () => {
  test.each(SCHEDULE_NAMES)(
    "keeps the words of the lines of %s clear of the boxes",
    (name) => {
      const model = realModel(name);
      const clashes = expansions(model).flatMap((expanded) => {
        const layout = layoutOriginGraph(model, expanded);
        const boxes: Box[] = [layout.origin, ...layout.nodes];
        return wordBoxes(layout).flatMap(({ item, box }) =>
          boxes
            .filter((other) => overlaps(box, other))
            .map(
              () =>
                `${[...expanded].join(",") || "closed"}: ${item.edge.from}->${item.edge.to}`,
            ),
        );
      });

      expect(clashes).toEqual([]);
    },
  );

  test.each(SCHEDULE_NAMES)(
    "keeps the words of the lines of %s clear of the other lines and words",
    (name) => {
      const model = realModel(name);
      const clashes = expansions(model).flatMap((expanded) => {
        const layout = layoutOriginGraph(model, expanded);
        const words = wordBoxes(layout);
        return words.flatMap(({ item, box }) =>
          layout.edges.flatMap((other) => {
            const onLine =
              other !== item &&
              segmentsOf(other.points).some((segment) =>
                passesThrough(segment, box),
              );
            const onWord = words.some(
              (candidate) =>
                candidate.item !== item && overlaps(box, candidate.box),
            );
            return onLine || onWord
              ? [
                  `${[...expanded].join(",") || "closed"}: ${item.edge.from}->${item.edge.to}`,
                ]
              : [];
          }),
        );
      });

      expect(clashes).toEqual([]);
    },
  );
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
