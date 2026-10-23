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

const NODE_KINDS: readonly string[] = ["schedule", "script", "flow", "human"];
const EDGE_KINDS: readonly string[] = ["schedule", "run", "human", "step"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeKind(value: unknown): value is GraphNodeKind {
  return typeof value === "string" && NODE_KINDS.includes(value);
}

function isEdgeKind(value: unknown): value is GraphEdgeKind {
  return typeof value === "string" && EDGE_KINDS.includes(value);
}

function readNode(value: unknown): GraphNode | null {
  if (!isRecord(value)) return null;
  const { id, kind, label, note } = value;
  if (typeof id !== "string" || id === "") return null;
  if (!isNodeKind(kind)) return null;
  if (typeof label !== "string" || typeof note !== "string") return null;
  return { id, kind, label, note };
}

function readEdge(value: unknown): GraphEdge | null {
  if (!isRecord(value)) return null;
  const { from, to, kind } = value;
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!isEdgeKind(kind)) return null;
  return { from, to, kind };
}

/**
 * 値を起動関係のグラフとして読む。形が違えばnullを返す。
 * ノードのidは一意で、辺の両端は存在するノードでなければならない。
 * 図の組み立ては、この条件を前提にする。
 */
export function parseFlowGraph(value: unknown): FlowGraph | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const nodes: GraphNode[] = [];
  for (const raw of value.nodes) {
    const node = readNode(raw);
    if (node === null) return null;
    nodes.push(node);
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) return null;
  const edges: GraphEdge[] = [];
  for (const raw of value.edges) {
    const edge = readEdge(raw);
    if (edge === null || !ids.has(edge.from) || !ids.has(edge.to)) return null;
    edges.push(edge);
  }
  return { nodes, edges };
}
