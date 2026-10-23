import { describe, expect, test } from "bun:test";
import { buildRenderMessage } from "./drawioMessages.ts";
import type { FlowGraph } from "./flowGraph.ts";
import { FLOW_GRAPH } from "./flowGraphData.ts";
import { flowGraphToDrawioXml } from "./flowGraphXml.ts";

const GRAPH: FlowGraph = {
  nodes: [
    {
      id: "schedule:poll_prs",
      kind: "schedule",
      label: "poll_prs",
      note: "0 */5 * * * *",
    },
    { id: "script:poll_prs", kind: "script", label: "poll_prs", note: "" },
    { id: "flow:pr_fix", kind: "flow", label: "pr_fix", note: "修正" },
    { id: "human:op:form", kind: "human", label: "人が実行", note: "" },
    { id: "flow:manual", kind: "flow", label: "manual", note: "" },
  ],
  edges: [
    { from: "schedule:poll_prs", to: "script:poll_prs", kind: "schedule" },
    { from: "script:poll_prs", to: "flow:pr_fix", kind: "run" },
    { from: "human:op:form", to: "flow:manual", kind: "human" },
    { from: "flow:pr_fix", to: "script:poll_prs", kind: "step" },
  ],
};

function count(xml: string, pattern: RegExp): number {
  return [...xml.matchAll(pattern)].length;
}

function attributes(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

describe("flowGraphToDrawioXml", () => {
  test("is an uncompressed mxfile", () => {
    expect(flowGraphToDrawioXml(GRAPH).startsWith("<mxfile")).toBe(true);
  });

  test("draws one vertex per node", () => {
    expect(count(flowGraphToDrawioXml(GRAPH), /vertex="1"/g)).toBe(5);
  });

  test("draws one edge per edge", () => {
    expect(count(flowGraphToDrawioXml(GRAPH), /edge="1"/g)).toBe(4);
  });

  test("gives every cell a different id", () => {
    const ids = attributes(flowGraphToDrawioXml(GRAPH), "id");

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("connects every edge to existing vertices", () => {
    const xml = flowGraphToDrawioXml(GRAPH);
    const ids = new Set(attributes(xml, "id"));
    const ends = [...attributes(xml, "source"), ...attributes(xml, "target")];

    expect(ends.filter((end) => !ids.has(end))).toEqual([]);
  });

  test("does not put two vertices at the same place", () => {
    const xml = flowGraphToDrawioXml(GRAPH);
    const places = [
      ...xml.matchAll(/<mxGeometry x="([^"]*)" y="([^"]*)"/g),
    ].map((match) => `${match[1] ?? ""},${match[2] ?? ""}`);

    expect(new Set(places).size).toBe(5);
  });

  test("escapes a label as HTML and then as an attribute", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", kind: "flow", label: 'a<b>&"c"', note: "" }],
      edges: [],
    };

    expect(flowGraphToDrawioXml(graph)).toContain(
      'value="a&amp;lt;b&amp;gt;&amp;amp;&quot;c&quot;"',
    );
  });

  test("puts the note on a second line of the label", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", kind: "flow", label: "x", note: "y" }],
      edges: [],
    };

    expect(flowGraphToDrawioXml(graph)).toContain('value="x&lt;br&gt;y"');
  });

  test("does not put a link, an anchor, or placeholders in the document", () => {
    const xml = flowGraphToDrawioXml(GRAPH);

    expect(/link=|<a[\s>]|&lt;a[\s&]|placeholders/.test(xml)).toBe(false);
  });

  test("returns the same document for the same graph", () => {
    expect(flowGraphToDrawioXml(GRAPH)).toBe(flowGraphToDrawioXml(GRAPH));
  });

  test("fits the size limit of the frame for the bundled graph", () => {
    const xml = FLOW_GRAPH === null ? "" : flowGraphToDrawioXml(FLOW_GRAPH);

    expect(buildRenderMessage(xml).ok).toBe(true);
  });
});
