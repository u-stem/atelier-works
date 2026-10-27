import { describe, expect, test } from "bun:test";
import type { FlowGraph, GraphNode } from "./flowGraph.ts";
import { FLOW_GRAPH } from "./flowGraphData.ts";
import { ITEM_KIND_FLOWS, itemFlowGraph } from "./itemFlowGraph.ts";

function node(id: string, kind: GraphNode["kind"]): GraphNode {
  return { id, kind, label: id, note: "" };
}

const SMALL: FlowGraph = {
  nodes: [
    node("flow:a", "flow"),
    node("flow:b", "flow"),
    node("flow:c", "flow"),
    node("script:link", "script"),
    node("script:solo", "script"),
    node("schedule:tick", "schedule"),
  ],
  edges: [
    { from: "flow:a", to: "script:link", kind: "step" },
    { from: "script:link", to: "flow:b", kind: "run" },
    { from: "script:solo", to: "flow:a", kind: "run" },
    { from: "script:solo", to: "flow:c", kind: "run" },
    { from: "schedule:tick", to: "script:solo", kind: "schedule" },
  ],
};

function idsOf(graph: FlowGraph): string[] {
  return graph.nodes.map((n) => n.id).sort();
}

describe("itemFlowGraph", () => {
  test("keeps the flows of the kind", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).toContain("flow:a");
  });

  test("drops the flows of other kinds", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).not.toContain("flow:c");
  });

  test("keeps a script that connects two flows of the kind", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).toContain("script:link");
  });

  test("drops a script that touches only one flow of the kind", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).not.toContain(
      "script:solo",
    );
  });

  test("drops the schedule that starts a script", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).not.toContain(
      "schedule:tick",
    );
  });

  test("keeps only the edges between the kept nodes", () => {
    const table = new Map([["demo", ["flow:a", "flow:b"]]]);
    expect(
      itemFlowGraph("demo", SMALL, table).edges.map((e) => `${e.from}>${e.to}`),
    ).toEqual(["flow:a>script:link", "script:link>flow:b"]);
  });

  test("holds a lone flow without any edge for a kind with one flow", () => {
    const table = new Map([["demo", ["flow:c"]]]);
    expect(itemFlowGraph("demo", SMALL, table)).toEqual({
      nodes: [node("flow:c", "flow")],
      edges: [],
    });
  });

  test("gives an empty graph for a kind it does not know", () => {
    expect(itemFlowGraph("brand_new", SMALL, new Map())).toEqual({
      nodes: [],
      edges: [],
    });
  });

  test("skips a flow of the table that the graph does not have", () => {
    const table = new Map([["demo", ["flow:a", "flow:missing"]]]);
    expect(idsOf(itemFlowGraph("demo", SMALL, table))).toEqual(["flow:a"]);
  });
});

describe("itemFlowGraph on the generated graph", () => {
  const graph = FLOW_GRAPH ?? { nodes: [], edges: [] };

  test("every flow of the table is a flow of the generated graph", () => {
    const flows = new Set(
      graph.nodes.filter((n) => n.kind === "flow").map((n) => n.id),
    );
    const listed = [...ITEM_KIND_FLOWS.values()].flat();
    expect(listed.filter((id) => !flows.has(id))).toEqual([]);
  });

  test("an issue passes through pipeline, design and implement", () => {
    expect(
      idsOf(itemFlowGraph("issue", graph)).filter((id) =>
        id.startsWith("flow:"),
      ),
    ).toEqual(["flow:design", "flow:implement", "flow:pipeline"]);
  });

  test("an issue keeps the script that applies an approval", () => {
    expect(idsOf(itemFlowGraph("issue", graph))).toContain(
      "script:steps/requirements_apply",
    );
  });

  test("an issue leaves out the polling scripts of other kinds", () => {
    expect(idsOf(itemFlowGraph("issue", graph))).not.toContain(
      "script:poll_prs",
    );
  });

  test.each([
    ["pr_review", "flow:pr_review"],
    ["pr_fix", "flow:pr_fix"],
    ["audit", "flow:audit"],
    ["dependabot", "flow:dependabot"],
  ])("%s holds only %s", (kind, flowId) => {
    expect(idsOf(itemFlowGraph(kind, graph))).toEqual([flowId]);
  });
});
