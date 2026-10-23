import type { FlowGraph, GraphEdge, GraphNode } from "./flowGraph.ts";

export type LayoutBox = {
  readonly node: GraphNode;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Anchor = {
  readonly side: "left" | "right";
  /** 辺の高さの、箱の上端からの割合(0〜1)。 */
  readonly fraction: number;
  readonly x: number;
  readonly y: number;
};

export type LayoutLink = {
  readonly edge: GraphEdge;
  readonly exit: Anchor;
  readonly entry: Anchor;
};

export type FlowGraphLayout = {
  readonly boxes: readonly LayoutBox[];
  readonly links: readonly LayoutLink[];
};

export function layoutFlowGraph(_graph: FlowGraph): FlowGraphLayout {
  return { boxes: [], links: [] };
}
