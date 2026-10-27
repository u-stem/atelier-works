// 作業項目の種別ごとの経路を、起動関係のグラフから切り出す純関数。
// 経路は、種別が通るflowと、それらを2つ以上つなぐscriptだけで作る。
// flowからflowへの起動はscriptを介するので、scriptを残さないと経路が切れる。

import type { FlowGraph } from "./flowGraph.ts";

/**
 * 作業項目の種別が通るflowのノードのid。
 * Issueは、要件定義(pipeline)、設計(design)、実装(implement)の順に進む。
 * PRのレビュー、PRの修正、監査、dependabotは、それぞれ1つのflowで完結する。
 */
export const ITEM_KIND_FLOWS: ReadonlyMap<string, readonly string[]> = new Map([
  ["issue", ["flow:pipeline", "flow:design", "flow:implement"]],
  ["pr_review", ["flow:pr_review"]],
  ["pr_fix", ["flow:pr_fix"]],
  ["audit", ["flow:audit"]],
  ["dependabot", ["flow:dependabot"]],
]);

export const NOT_ITEM_PATH_SCRIPTS: ReadonlySet<string> = new Set();

/**
 * 作業項目の種別が通るflowと、それをつなぐscriptだけのグラフ。
 * 表に無い種別と、グラフに無いflowは含めない。
 * 入口のスケジュールと人の操作は、作業項目の経路ではないので含めない。
 */
export function itemFlowGraph(
  kind: string,
  graph: FlowGraph,
  table: ReadonlyMap<string, readonly string[]> = ITEM_KIND_FLOWS,
  _excluded: ReadonlySet<string> = NOT_ITEM_PATH_SCRIPTS,
): FlowGraph {
  const flowIds = new Set(
    graph.nodes
      .filter(
        (node) =>
          node.kind === "flow" && (table.get(kind) ?? []).includes(node.id),
      )
      .map((node) => node.id),
  );
  const touched = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    for (const [self, other] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      if (!flowIds.has(other)) continue;
      touched.set(self, (touched.get(self) ?? new Set()).add(other));
    }
  }
  const keep = new Set(flowIds);
  for (const node of graph.nodes) {
    if (node.kind === "script" && (touched.get(node.id)?.size ?? 0) >= 2) {
      keep.add(node.id);
    }
  }
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter(
      (edge) => keep.has(edge.from) && keep.has(edge.to),
    ),
  };
}
