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

  test("draws the graph in a titled frame once it is opened", () => {
    expect(
      renderToStaticMarkup(<FlowGraphSection graph={GRAPH} initiallyOpen />),
    ).toContain('title="起動の関係の図"');
  });

  test("does not draw the frame while the graph is folded", () => {
    expect(
      renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />),
    ).not.toContain("<iframe");
  });

  test("folds the graph", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toMatch(
      /<details(?![^>]* open)/,
    );
  });

  test("stays closed on a jump, since no chip leads here", () => {
    expect(
      renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />),
    ).not.toContain("data-jump-open");
  });

  test("can start open", () => {
    expect(
      renderToStaticMarkup(<FlowGraphSection graph={GRAPH} initiallyOpen />),
    ).toMatch(/<details[^>]* open/);
  });

  test("lets a heading link land on the heading", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toMatch(
      /<h2 id="flow-graph-heading" tabindex="-1"/,
    );
  });

  test("explains the arrows", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toContain(
      "破線",
    );
  });

  test("says that a launch from one script to another is not drawn", () => {
    expect(renderToStaticMarkup(<FlowGraphSection graph={GRAPH} />)).toContain(
      "scriptからscriptの起動は含みません",
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
