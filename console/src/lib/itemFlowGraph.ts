// 作業項目の種別ごとの経路を、起動関係のグラフから切り出す純関数。

import type { FlowGraph } from "./flowGraph.ts";

/** 種別が通るflowのノードのid。 */
export const ITEM_KIND_FLOWS: ReadonlyMap<string, readonly string[]> =
  new Map();

/** 作業項目の種別が通るflowと、それをつなぐscriptだけのグラフ。 */
export function itemFlowGraph(
  _kind: string,
  _graph: FlowGraph,
  _table: ReadonlyMap<string, readonly string[]> = ITEM_KIND_FLOWS,
): FlowGraph {
  return { nodes: [], edges: [] };
}
