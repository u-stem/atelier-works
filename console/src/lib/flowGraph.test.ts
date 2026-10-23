import { describe, expect, test } from "bun:test";
import { parseFlowGraph } from "./flowGraph.ts";
import { FLOW_GRAPH } from "./flowGraphData.ts";

const VALID = {
  nodes: [
    { id: "schedule:poll_prs", kind: "schedule", label: "poll_prs", note: "x" },
    { id: "script:poll_prs", kind: "script", label: "poll_prs", note: "" },
  ],
  edges: [
    { from: "schedule:poll_prs", to: "script:poll_prs", kind: "schedule" },
  ],
};

describe("parseFlowGraph", () => {
  test("reads a graph of the expected shape", () => {
    expect(parseFlowGraph(VALID)?.nodes.map((node) => node.id)).toEqual([
      "schedule:poll_prs",
      "script:poll_prs",
    ]);
  });

  test("rejects a value that is not an object", () => {
    expect(parseFlowGraph(null)).toBeNull();
  });

  test("rejects a node of an unknown kind", () => {
    const value = {
      ...VALID,
      nodes: [{ id: "a", kind: "queue", label: "a", note: "" }],
      edges: [],
    };

    expect(parseFlowGraph(value)).toBeNull();
  });

  test("rejects a node whose label is not a string", () => {
    const value = {
      ...VALID,
      nodes: [{ id: "a", kind: "flow", label: 1, note: "" }],
      edges: [],
    };

    expect(parseFlowGraph(value)).toBeNull();
  });

  test("rejects two nodes with the same id", () => {
    const node = { id: "a", kind: "flow", label: "a", note: "" };

    expect(parseFlowGraph({ nodes: [node, node], edges: [] })).toBeNull();
  });

  test("rejects an edge of an unknown kind", () => {
    const value = {
      ...VALID,
      edges: [{ from: "schedule:poll_prs", to: "script:poll_prs", kind: "x" }],
    };

    expect(parseFlowGraph(value)).toBeNull();
  });

  test("rejects an edge that points at a missing node", () => {
    const value = {
      ...VALID,
      edges: [{ from: "schedule:poll_prs", to: "script:none", kind: "run" }],
    };

    expect(parseFlowGraph(value)).toBeNull();
  });
});

describe("the graph bundled into the console", () => {
  test("has the expected shape", () => {
    expect(FLOW_GRAPH).not.toBeNull();
  });
});
