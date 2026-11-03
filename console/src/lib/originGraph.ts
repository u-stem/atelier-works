// 起動の図の組み立て。定期ジョブから前進の辺(起動と承認)でたどれるflowを段に並べ、箱と線の座標を決める純関数。
// 語は`screens/jobs/OriginDiagram.tsx`が表示する。

import type { Box, Point } from "./flowDiagram.ts";
import type { ExitVia, FlowDefinition, FlowsData } from "./flowsData.ts";

/** flowの出口1つ。同じ経路と行き先の出口は1つにまとめる。 */
export type OriginExit = {
  readonly via: ExitVia;
  readonly to: string;
  /** そのflow自身へ戻る出口(却下の作り直し)。 */
  readonly self: boolean;
  /** 線で描く前進の辺か。偽なら、足の注記にする。 */
  readonly drawn: boolean;
  /** 出口がつくステップのid。 */
  readonly step: string;
  /** 注記と一覧に書く文。 */
  readonly text: string;
};

export type OriginFlowNode = {
  readonly flow: FlowDefinition;
  /** 起点の箱が0で、起点が起動するflowが1。 */
  readonly column: number;
  readonly exits: readonly OriginExit[];
};

/** 前進の辺。`from`が`null`なら起点の箱から。 */
export type OriginEdge = {
  readonly from: string | null;
  readonly to: string;
  readonly via: "launch" | "approve";
  /** 出口がつくステップのid。起点の箱からの辺は`null`。 */
  readonly step: string | null;
  /** 結ぶ段の差。2以上なら、間の段の箱の下を回して描く。 */
  readonly span: number;
};

export type OriginGraphModel = {
  readonly origin: { readonly name: string; readonly summary: string };
  readonly nodes: readonly OriginFlowNode[];
  readonly edges: readonly OriginEdge[];
  /** 起点の箱を含む段の数。 */
  readonly columns: number;
  /** 承認の線か、戻りの注記があり、設定や試行の上限で起動しないことがある。 */
  readonly conditional: boolean;
};

/** 起動の図を組み立てる。`scheduleName`のscheduleが無ければ`null`にする。 */
export function originGraphModel(
  data: FlowsData,
  scheduleName: string,
): OriginGraphModel | null {
  void data;
  void scheduleName;
  return null;
}

/** 足の注記にする出口。 */
export function footNotes(node: OriginFlowNode): readonly OriginExit[] {
  return node.exits.filter((exit) => !exit.drawn);
}

/** 初めから開いておくflow。起動するflowが1つだけのscheduleは、そのflowを開く。 */
export function initialExpanded(model: OriginGraphModel): ReadonlySet<string> {
  void model;
  return new Set(["stub"]);
}

export const ORIGIN_WIDTH = 180;
export const ORIGIN_HEIGHT = 112;
export const NODE_WIDTH = 200;
export const COLUMN_GAP = 96;

export type OriginStepRow = {
  readonly id: string;
  readonly y: number;
  readonly height: number;
};

export type OriginNodeLayout = Box & {
  readonly flow: string;
  readonly column: number;
  readonly expanded: boolean;
  /** 見出し(flow名、説明、ステップ数、開閉の印)の高さ。 */
  readonly headerHeight: number;
  /** 開いたときのステップの行。たたんだときは空。 */
  readonly steps: readonly OriginStepRow[];
  /** 「flowの図」のリンクの行のy。たたんだときは`null`。 */
  readonly linkY: number | null;
  readonly notes: readonly { readonly text: string; readonly y: number }[];
};

export type OriginEdgeLayout = {
  readonly edge: OriginEdge;
  readonly points: readonly Point[];
  /** 語「承認」を置く位置。承認の線だけが持つ。 */
  readonly label: Point | null;
};

export type OriginLayout = {
  readonly origin: Box;
  readonly nodes: readonly OriginNodeLayout[];
  readonly edges: readonly OriginEdgeLayout[];
  readonly width: number;
  readonly height: number;
};

/** 起動の図の配置を決める。ノードの幅は、開閉で変えない。 */
export function layoutOriginGraph(
  model: OriginGraphModel,
  expanded: ReadonlySet<string>,
): OriginLayout {
  void model;
  void expanded;
  return {
    origin: { x: 0, y: 0, width: 0, height: 0 },
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
  };
}
