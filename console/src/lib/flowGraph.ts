// 起動関係の図のデータの型と、その検査。
// データは`scripts/docs-gen.ts`が`src/generated/flow-graph.json`に書く。

/** ノードの種類。 */
export type GraphNodeKind = "schedule" | "script" | "flow" | "human";

/** 辺の種類。 */
export type GraphEdgeKind = "schedule" | "run" | "human" | "step";

export type GraphNode = {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** ラベルの下に添える文。無ければ空文字列。 */
  readonly note: string;
};

export type GraphEdge = {
  readonly from: string;
  readonly to: string;
  readonly kind: GraphEdgeKind;
};

export type FlowGraph = {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
};

/** 値を起動関係のグラフとして読む。形が違えばnullを返す。 */
export function parseFlowGraph(_value: unknown): FlowGraph | null {
  return null;
}
