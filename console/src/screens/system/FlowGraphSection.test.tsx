import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { FlowGraphSection } from "./FlowGraphSection.tsx";

const GRAPH: FlowGraph = {
  nodes: [{ id: "flow:pipeline", kind: "flow", label: "pipeline", note: "" }],
  edges: [],
};

describe("FlowGraphSection", () => {
  test("has a heading for the section", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toContain(
      "起動の関係",
    );
  });

  test("draws the graph in a titled frame", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toContain(
      'title="起動の関係の図"',
    );
  });

  test("explains the arrows", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toContain(
      "破線",
    );
  });

  test("says so when the data cannot be read", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={null} />)).toContain(
      "起動の関係のデータを読み込めませんでした",
    );
  });

  test("does not draw a frame when the data cannot be read", () => {
    expect(
      renderToStaticMarkup(<FlowGraphSection graph={null} />),
    ).not.toContain("<iframe");
  });
});
