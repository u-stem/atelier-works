import { describe, expect, test } from "bun:test";
import type { FlowGraph } from "./flowGraph.ts";
import { FLOW_GRAPH } from "./flowGraphData.ts";
import {
  type FlowGraphLayout,
  LAYOUT_MARGIN,
  type LayoutBox,
  layoutExtent,
  layoutFlowGraph,
} from "./flowGraphLayout.ts";

const GRAPH: FlowGraph = {
  nodes: [
    { id: "schedule:a", kind: "schedule", label: "a", note: "" },
    { id: "schedule:direct", kind: "schedule", label: "direct", note: "" },
    { id: "script:a", kind: "script", label: "a", note: "" },
    { id: "script:b", kind: "script", label: "b", note: "" },
    { id: "human:entry:b", kind: "human", label: "console", note: "" },
    { id: "human:op:form", kind: "human", label: "form", note: "" },
    { id: "flow:x", kind: "flow", label: "x", note: "" },
    { id: "flow:y", kind: "flow", label: "y", note: "" },
  ],
  edges: [
    { from: "schedule:a", to: "script:a", kind: "schedule" },
    { from: "schedule:direct", to: "flow:y", kind: "schedule" },
    { from: "human:entry:b", to: "script:b", kind: "human" },
    { from: "human:op:form", to: "flow:y", kind: "human" },
    { from: "script:a", to: "flow:x", kind: "run" },
    { from: "script:a", to: "flow:y", kind: "run" },
    { from: "script:b", to: "flow:x", kind: "run" },
    { from: "flow:x", to: "script:b", kind: "step" },
  ],
};

type Point = { readonly x: number; readonly y: number };

/** 線分が矩形(境界を含む)と交わるかを、Liang-Barskyの切り取りで判定する。 */
function segmentHitsBox(from: Point, to: Point, box: LayoutBox): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bounds: ReadonlyArray<readonly [number, number]> = [
    [-dx, from.x - box.x],
    [dx, box.x + box.width - from.x],
    [-dy, from.y - box.y],
    [dy, box.y + box.height - from.y],
  ];
  let enter = 0;
  let leave = 1;
  for (const [p, q] of bounds) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
  }
  return enter <= leave;
}

function boxById(layout: FlowGraphLayout, id: string): LayoutBox | undefined {
  return layout.boxes.find((box) => box.node.id === id);
}

/** 辺が、両端以外のノードの箱を通るものの一覧。 */
function crossings(layout: FlowGraphLayout): string[] {
  return layout.links.flatMap((link) =>
    layout.boxes
      .filter(
        (box) =>
          box.node.id !== link.edge.from &&
          box.node.id !== link.edge.to &&
          segmentHitsBox(link.exit, link.entry, box),
      )
      .map(
        (box) => `${link.edge.from} -> ${link.edge.to} crosses ${box.node.id}`,
      ),
  );
}

function bothGraphs(): ReadonlyArray<readonly [string, FlowGraph]> {
  return FLOW_GRAPH === null
    ? [["fixture", GRAPH]]
    : [
        ["fixture", GRAPH],
        ["bundled", FLOW_GRAPH],
      ];
}

describe("segmentHitsBox", () => {
  test("detects a segment that passes through a box", () => {
    const box: LayoutBox = {
      node: { id: "a", kind: "flow", label: "a", note: "" },
      column: 0,
      x: 10,
      y: 10,
      width: 10,
      height: 10,
    };

    expect(segmentHitsBox({ x: 0, y: 15 }, { x: 30, y: 15 }, box)).toBe(true);
  });
});

describe("layoutFlowGraph", () => {
  test("places one box per node", () => {
    expect(layoutFlowGraph(GRAPH).boxes.length).toBe(8);
  });

  test("places one link per edge", () => {
    expect(layoutFlowGraph(GRAPH).links.length).toBe(8);
  });

  test("puts a schedule that runs a script left of the scripts", () => {
    const layout = layoutFlowGraph(GRAPH);

    expect(boxById(layout, "schedule:a")?.column).toBe(0);
  });

  test("puts a schedule that runs a flow in the column of the scripts", () => {
    const layout = layoutFlowGraph(GRAPH);

    expect(boxById(layout, "schedule:direct")?.column).toBe(
      boxById(layout, "script:a")?.column,
    );
  });

  test("puts a human operation that starts a flow in the column of the scripts", () => {
    const layout = layoutFlowGraph(GRAPH);

    expect(boxById(layout, "human:op:form")?.column).toBe(
      boxById(layout, "script:a")?.column,
    );
  });

  test("puts a console operation that runs a script left of the scripts", () => {
    const layout = layoutFlowGraph(GRAPH);

    expect(boxById(layout, "human:entry:b")?.column).toBe(0);
  });

  for (const [name, graph] of bothGraphs()) {
    test(`joins only neighbouring columns (${name})`, () => {
      const layout = layoutFlowGraph(graph);
      const far = layout.links.filter((link) => {
        const from = boxById(layout, link.edge.from)?.column ?? 0;
        const to = boxById(layout, link.edge.to)?.column ?? 0;
        return Math.abs(from - to) !== 1;
      });

      expect(far.map((link) => link.edge)).toEqual([]);
    });

    test(`keeps every link out of the boxes of other nodes (${name})`, () => {
      expect(crossings(layoutFlowGraph(graph))).toEqual([]);
    });

    test(`does not overlap boxes (${name})`, () => {
      const layout = layoutFlowGraph(graph);
      const overlaps = layout.boxes.flatMap((a, i) =>
        layout.boxes
          .slice(i + 1)
          .filter(
            (b) =>
              a.x < b.x + b.width &&
              b.x < a.x + a.width &&
              a.y < b.y + b.height &&
              b.y < a.y + a.height,
          )
          .map((b) => `${a.node.id} / ${b.node.id}`),
      );

      expect(overlaps).toEqual([]);
    });

    test(`gives links on the same side of a box different heights (${name})`, () => {
      const layout = layoutFlowGraph(graph);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const link of layout.links) {
        const keys = [
          `${link.edge.from} ${link.exit.side} ${link.exit.y}`,
          `${link.edge.to} ${link.entry.side} ${link.entry.y}`,
        ];
        for (const key of keys) {
          if (seen.has(key)) duplicates.push(key);
          seen.add(key);
        }
      }

      expect(duplicates).toEqual([]);
    });

    test(`stays within the height the frame can show (${name})`, () => {
      const bottom = Math.max(
        ...layoutFlowGraph(graph).boxes.map((box) => box.y + box.height),
      );

      expect(bottom).toBeLessThanOrEqual(1500);
    });
  }

  test("leaves a link from the right side of its source to the left side of its target", () => {
    const layout = layoutFlowGraph(GRAPH);
    const link = layout.links.find(
      (candidate) =>
        candidate.edge.from === "script:a" && candidate.edge.to === "flow:x",
    );

    expect([link?.exit.side, link?.entry.side]).toEqual(["right", "left"]);
  });

  test("leaves a step link from the left side of the flow to the right side of the script", () => {
    const layout = layoutFlowGraph(GRAPH);
    const link = layout.links.find(
      (candidate) => candidate.edge.kind === "step",
    );

    expect([link?.exit.side, link?.entry.side]).toEqual(["left", "right"]);
  });

  test("gives a flow box room for a name and a two-line note", () => {
    const layout = layoutFlowGraph(GRAPH);

    expect(boxById(layout, "flow:x")?.height).toBeGreaterThanOrEqual(72);
  });

  for (const [name, graph] of bothGraphs()) {
    test(`leaves the margin below the lowest box (${name})`, () => {
      const layout = layoutFlowGraph(graph);
      const bottom = Math.max(...layout.boxes.map((box) => box.y + box.height));

      expect(layoutExtent(layout).height).toBe(bottom + LAYOUT_MARGIN);
    });

    test(`leaves the margin right of the rightmost box (${name})`, () => {
      const layout = layoutFlowGraph(graph);
      const right = Math.max(...layout.boxes.map((box) => box.x + box.width));

      expect(layoutExtent(layout).width).toBe(right + LAYOUT_MARGIN);
    });
  }

  test("returns the same layout for the same graph", () => {
    expect(layoutFlowGraph(GRAPH)).toEqual(layoutFlowGraph(GRAPH));
  });
});

describe("layoutFlowGraph without the first column", () => {
  const PATH: FlowGraph = {
    nodes: [
      { id: "script:s", kind: "script", label: "s", note: "" },
      { id: "flow:x", kind: "flow", label: "x", note: "" },
    ],
    edges: [{ from: "script:s", to: "flow:x", kind: "run" }],
  };
  const LONE: FlowGraph = {
    nodes: [{ id: "flow:x", kind: "flow", label: "x", note: "" }],
    edges: [],
  };

  test("moves the leftmost box to the margin", () => {
    const layout = layoutFlowGraph(PATH);
    expect(Math.min(...layout.boxes.map((box) => box.x))).toBe(LAYOUT_MARGIN);
  });

  test("moves a lone flow to the margin", () => {
    expect(layoutFlowGraph(LONE).boxes[0]?.x).toBe(LAYOUT_MARGIN);
  });

  test("keeps the gap between the two columns that remain", () => {
    const layout = layoutFlowGraph(PATH);
    expect(
      (boxById(layout, "flow:x")?.x ?? 0) -
        (boxById(layout, "script:s")?.x ?? 0),
    ).toBe(400);
  });

  test("moves the links with the boxes", () => {
    const layout = layoutFlowGraph(PATH);
    const box = boxById(layout, "script:s");
    expect(layout.links[0]?.exit.x).toBe((box?.x ?? 0) + (box?.width ?? 0));
  });

  test("narrows the figure by the empty column", () => {
    expect(layoutExtent(layoutFlowGraph(PATH)).width).toBe(680);
  });

  test("leaves a graph that uses the first column where it was", () => {
    const layout = layoutFlowGraph(GRAPH);
    expect(boxById(layout, "schedule:a")?.x).toBe(LAYOUT_MARGIN);
  });
});
