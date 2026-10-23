// 起動関係の静的グラフ(スケジュール、script、flow、人の操作とそれらをつなぐ辺)を作る。
// 元データは`scripts/launch-graph.ts`の表、`*.schedule.yaml`、flowの定義である。
// 純関数だけを置く。ファイルの読み込みと書き出しは`scripts/docs-gen.ts`が行う。

import type {
  FlowGraph,
  GraphEdge,
  GraphNode,
} from "../console/src/lib/flowGraph.ts";
import type { LaunchEdge } from "./launch-graph.ts";

export type ScheduleInput = {
  /** `f/factory/<name>.schedule.yaml`の`<name>`。 */
  readonly name: string;
  readonly cron: string;
  /** スケジュールが実行するscriptかflowのpath(`f/factory/poll_issues`)。 */
  readonly target: string;
  readonly isFlow: boolean;
};

export type FlowInput = {
  readonly name: string;
  readonly summary: string;
  /** flowのモジュールが実行するscriptのpath(`f/factory/steps/pr_fix_finish`)。 */
  readonly stepPaths: readonly string[];
};

export type FlowGraphInput = {
  readonly edges: readonly LaunchEdge[];
  readonly humanOperations: Readonly<Record<string, string>>;
  readonly humanEntryScripts: Readonly<Record<string, string>>;
  readonly schedules: readonly ScheduleInput[];
  readonly flows: readonly FlowInput[];
};

const FACTORY_PREFIX = "f/factory/";

const NODE_ORDER: Readonly<Record<GraphNode["kind"], number>> = {
  schedule: 0,
  human: 1,
  script: 2,
  flow: 3,
};

const EDGE_ORDER: Readonly<Record<GraphEdge["kind"], number>> = {
  schedule: 0,
  human: 1,
  run: 2,
  step: 3,
};

/** `f/factory/`からの相対パスにする。 */
function relativeToFactory(path: string): string {
  return path.startsWith(FACTORY_PREFIX)
    ? path.slice(FACTORY_PREFIX.length)
    : path;
}

/** summaryの先頭の`[SF-2-1]`などの接頭辞を除く。 */
function withoutIdPrefix(summary: string): string {
  return summary.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 起動関係のグラフを作る。ノードと辺の並びは入力の並びに依らない。
 * - flowのノードは、すべてのflowに作る
 * - scriptのノードは、flowを起動するscriptだけに作る
 * - スケジュールのノードは、そのscriptかflowを実行するスケジュールだけに作る
 * - 人の操作のノードは、flowを起動する操作と、scriptを動かすConsoleの操作に作る
 * - flowからscriptへの辺は、flowのモジュールが、flowを起動するscriptを実行するときに引く
 * 起動の辺が存在しないflowを指していれば、例外を投げる。
 */
export function buildFlowGraph(input: FlowGraphInput): FlowGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode): void => {
    nodes.set(node.id, node);
  };
  const addEdge = (edge: GraphEdge): void => {
    edges.set(`${edge.kind} ${edge.from} ${edge.to}`, edge);
  };

  for (const flow of input.flows) {
    addNode({
      id: `flow:${flow.name}`,
      kind: "flow",
      label: flow.name,
      note: withoutIdPrefix(flow.summary),
    });
  }

  for (const edge of input.edges) {
    if (!nodes.has(`flow:${edge.to}`)) {
      throw new Error(`launch edge targets an unknown flow: ${edge.to}`);
    }
    if (edge.kind === "human") {
      const id = `human:op:${edge.from}`;
      addNode({
        id,
        kind: "human",
        label: input.humanOperations[edge.from] ?? edge.from,
        note: "",
      });
      addEdge({ from: id, to: `flow:${edge.to}`, kind: "human" });
      continue;
    }
    const scriptId = `script:${edge.from}`;
    addNode({ id: scriptId, kind: "script", label: edge.from, note: "" });
    addEdge({ from: scriptId, to: `flow:${edge.to}`, kind: "run" });
    const entry = input.humanEntryScripts[edge.from];
    if (entry !== undefined) {
      const entryId = `human:entry:${edge.from}`;
      addNode({ id: entryId, kind: "human", label: entry, note: "" });
      addEdge({ from: entryId, to: scriptId, kind: "human" });
    }
  }

  for (const schedule of input.schedules) {
    const target = relativeToFactory(schedule.target);
    const targetId = `${schedule.isFlow ? "flow" : "script"}:${target}`;
    if (!nodes.has(targetId)) continue;
    const id = `schedule:${schedule.name}`;
    addNode({
      id,
      kind: "schedule",
      label: schedule.name,
      note: schedule.cron,
    });
    addEdge({ from: id, to: targetId, kind: "schedule" });
  }

  for (const flow of input.flows) {
    for (const path of flow.stepPaths) {
      const scriptId = `script:${relativeToFactory(path)}`;
      if (nodes.has(scriptId)) {
        addEdge({ from: `flow:${flow.name}`, to: scriptId, kind: "step" });
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort(
      (a, b) =>
        NODE_ORDER[a.kind] - NODE_ORDER[b.kind] || compareText(a.id, b.id),
    ),
    edges: [...edges.values()].sort(
      (a, b) =>
        EDGE_ORDER[a.kind] - EDGE_ORDER[b.kind] ||
        compareText(a.from, b.from) ||
        compareText(a.to, b.to),
    ),
  };
}

/** グラフをJSONの文字列にする。末尾に改行を付ける。 */
export function renderFlowGraphJson(graph: FlowGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
