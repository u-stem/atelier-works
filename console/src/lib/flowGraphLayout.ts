// 起動関係のグラフの配置を、座標として決める純関数。
// 箱は3列に並べる。辺は、隣り合う列の間だけを直線で結ぶので、他のノードの箱を通らない。
// 同じ箱の同じ側につく辺は、つなぎ先の高さの順に、箱の高さを等分した位置へ割り当てる。
// 位置が離れるので、列の間で辺が1本の線に重ならない。

import type {
  FlowGraph,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
} from "./flowGraph.ts";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 56;
/** flowは名前に説明が続き、折り返して3行になることがあるので、高く取る。 */
export const FLOW_NODE_HEIGHT = 72;
const COLUMN_GAP = 200;
const ROW_GAP = 16;
export const LAYOUT_MARGIN = 40;
const MARGIN = LAYOUT_MARGIN;
/** 並べ替えの往復の回数。ノードが数十個なら、数回で並びが落ち着く。 */
const ORDER_PASSES = 4;
const COLUMN_COUNT = 3;

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
  /** 辺がつく高さの、箱の上端からの割合(0〜1)。 */
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

const FIXED_COLUMN: Readonly<Partial<Record<GraphNodeKind, number>>> = {
  script: 1,
  flow: 2,
};

/**
 * ノードの列を決める。scriptは2列目、flowは3列目に置く。
 * スケジュールと人の操作は、scriptを起動するなら1列目、flowを直接起動するなら
 * scriptと同じ2列目に置く。どの辺も隣り合う列を結ぶので、列をまたぐ辺が出ない。
 */
function columnsOf(graph: FlowGraph): Map<string, number> {
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const startsFlow = new Set(
    graph.edges
      .filter((edge) => kindOf.get(edge.to) === "flow")
      .map((edge) => edge.from),
  );
  return new Map(
    graph.nodes.map((node) => [
      node.id,
      FIXED_COLUMN[node.kind] ?? (startsFlow.has(node.id) ? 1 : 0),
    ]),
  );
}

/** 列ごとのノードの並びを、つながる先の位置の平均で整える。 */
function orderColumns(
  graph: FlowGraph,
  columnOf: ReadonlyMap<string, number>,
): GraphNode[][] {
  const columns: GraphNode[][] = Array.from({ length: COLUMN_COUNT }, () => []);
  for (const node of graph.nodes) {
    columns[columnOf.get(node.id) ?? 0]?.push(node);
  }

  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }

  const position = new Map<string, number>();
  const record = (): void => {
    for (const column of columns) {
      column.forEach((node, index) => {
        position.set(node.id, (index + 0.5) / column.length);
      });
    }
  };
  record();

  for (let pass = 0; pass < ORDER_PASSES; pass += 1) {
    for (const index of [1, 0, 2]) {
      const column = columns[index];
      if (column === undefined) continue;
      const keyed = column.map((node, order) => {
        const near = neighbors.get(node.id) ?? [];
        const own = position.get(node.id) ?? 0;
        const key =
          near.length === 0
            ? own
            : near.reduce((sum, id) => sum + (position.get(id) ?? own), 0) /
              near.length;
        return { node, order, key };
      });
      keyed.sort((a, b) => a.key - b.key || a.order - b.order);
      columns[index] = keyed.map((entry) => entry.node);
      record();
    }
  }
  return columns;
}

function heightOf(node: GraphNode): number {
  return node.kind === "flow" ? FLOW_NODE_HEIGHT : NODE_HEIGHT;
}

/** 箱を列ごとに置く。短い列は、いちばん長い列の高さに均等に散らす。 */
function placeBoxes(columns: readonly (readonly GraphNode[])[]): LayoutBox[] {
  const total = Math.max(
    1,
    ...columns.map(
      (column) =>
        column.length * (Math.max(0, ...column.map(heightOf)) + ROW_GAP),
    ),
  );
  return columns.flatMap((column, columnIndex) =>
    column.map((node, row) => ({
      node,
      column: columnIndex,
      x: MARGIN + columnIndex * (NODE_WIDTH + COLUMN_GAP),
      y:
        MARGIN +
        Math.round(((row + 0.5) / column.length) * total - heightOf(node) / 2),
      width: NODE_WIDTH,
      height: heightOf(node),
    })),
  );
}

type Side = "left" | "right";
type Attachment = { readonly edgeIndex: number; readonly otherY: number };

function anchorOf(box: LayoutBox, side: Side, fraction: number): Anchor {
  return {
    side,
    fraction,
    x: side === "right" ? box.x + box.width : box.x,
    y: box.y + fraction * box.height,
  };
}

/**
 * 辺を、箱の側面につなぐ。右の列へ向かう辺は、元の右側から先の左側へ引く。
 * 左の列へ戻る辺(flowのステップ)は、元の左側から先の右側へ引く。
 */
export function layoutFlowGraph(graph: FlowGraph): FlowGraphLayout {
  const columnOf = columnsOf(graph);
  const boxes = placeBoxes(orderColumns(graph, columnOf));
  const boxOf = new Map(boxes.map((box) => [box.node.id, box]));

  const sides = graph.edges.map((edge) => {
    const from = boxOf.get(edge.from);
    const to = boxOf.get(edge.to);
    const forward = (from?.column ?? 0) <= (to?.column ?? 0);
    const exit: Side = forward ? "right" : "left";
    const entry: Side = forward ? "left" : "right";
    return { from, to, exit, entry };
  });

  const attachments = new Map<string, Attachment[]>();
  const attach = (id: string, side: Side, item: Attachment): void => {
    const key = `${id} ${side}`;
    attachments.set(key, [...(attachments.get(key) ?? []), item]);
  };
  graph.edges.forEach((edge, edgeIndex) => {
    const side = sides[edgeIndex];
    if (side?.from === undefined || side.to === undefined) return;
    const centerY = (box: LayoutBox): number => box.y + box.height / 2;
    attach(edge.from, side.exit, {
      edgeIndex,
      otherY: centerY(side.to),
    });
    attach(edge.to, side.entry, {
      edgeIndex,
      otherY: centerY(side.from),
    });
  });

  const fractionOf = (id: string, side: Side, edgeIndex: number): number => {
    const items = [...(attachments.get(`${id} ${side}`) ?? [])].sort(
      (a, b) => a.otherY - b.otherY || a.edgeIndex - b.edgeIndex,
    );
    const rank = items.findIndex((item) => item.edgeIndex === edgeIndex);
    return Number(((rank + 1) / (items.length + 1)).toFixed(3));
  };

  const links: LayoutLink[] = [];
  graph.edges.forEach((edge, edgeIndex) => {
    const side = sides[edgeIndex];
    if (side?.from === undefined || side.to === undefined) return;
    links.push({
      edge,
      exit: anchorOf(
        side.from,
        side.exit,
        fractionOf(edge.from, side.exit, edgeIndex),
      ),
      entry: anchorOf(
        side.to,
        side.entry,
        fractionOf(edge.to, side.entry, edgeIndex),
      ),
    });
  });
  return { boxes, links };
}

/** 図全体の大きさ。いちばん外側の箱の外に、余白を足した値。 */
export function layoutExtent(layout: FlowGraphLayout): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width:
      Math.max(0, ...layout.boxes.map((box) => box.x + box.width)) + MARGIN,
    height:
      Math.max(0, ...layout.boxes.map((box) => box.y + box.height)) + MARGIN,
  };
}
