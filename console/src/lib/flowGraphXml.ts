// 起動関係のグラフから、draw.ioの非圧縮XMLを組み立てる純関数。
// 図は信頼できない入力として隔離したiframeで描くので、リンク、`placeholders`、
// ラベルのHTMLの属性は出さない。ラベルは、HTMLの文字としてエスケープした後、
// XMLの属性値としてもう一度エスケープする。

import type {
  FlowGraph,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
} from "./flowGraph.ts";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const COLUMN_GAP = 160;
const ROW_GAP = 24;
const MARGIN = 40;
/** 並べ替えの往復の回数。ノードが数十個なら、数回で並びが落ち着く。 */
const ORDER_PASSES = 4;

/** 左から、入口(スケジュールと人の操作)、script、flowの3列に並べる。 */
const COLUMN_OF: Readonly<Record<GraphNodeKind, number>> = {
  schedule: 0,
  human: 0,
  script: 1,
  flow: 2,
};

const NODE_STYLE: Readonly<Record<GraphNodeKind, string>> = {
  schedule:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;",
  human:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;",
  script:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
  flow: "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
};

const EDGE_BASE =
  "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;";

/** 実線はscriptがflowを起動する関係、破線は時刻と人の操作による起動、点線はflowの中のステップ。 */
const EDGE_STYLE: Readonly<Record<GraphEdgeKind, string>> = {
  run: EDGE_BASE,
  schedule: `${EDGE_BASE}dashed=1;`,
  human: `${EDGE_BASE}dashed=1;`,
  step: `${EDGE_BASE}dashed=1;dashPattern=1 3;`,
};

const EDGE_LABEL: Readonly<Record<GraphEdgeKind, string>> = {
  run: "",
  schedule: "",
  human: "",
  step: "ステップ",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** ラベルと補足を、HTMLの改行でつないだ文字列を、属性値として返す。 */
function labelValue(node: GraphNode): string {
  const html =
    node.note === ""
      ? escapeHtml(node.label)
      : `${escapeHtml(node.label)}<br>${escapeHtml(node.note)}`;
  return escapeAttribute(html);
}

/** 列ごとのノードの並びを、つながる先の位置の平均で整える。 */
function orderColumns(graph: FlowGraph): GraphNode[][] {
  const columns: GraphNode[][] = [[], [], []];
  for (const node of graph.nodes) columns[COLUMN_OF[node.kind]]?.push(node);

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

function vertexCell(
  id: string,
  node: GraphNode,
  column: number,
  row: number,
): string {
  const x = MARGIN + column * (NODE_WIDTH + COLUMN_GAP);
  const y = MARGIN + row * (NODE_HEIGHT + ROW_GAP);
  return [
    `        <mxCell id="${id}" value="${labelValue(node)}" style="${NODE_STYLE[node.kind]}" vertex="1" parent="1">`,
    `          <mxGeometry x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" as="geometry" />`,
    "        </mxCell>",
  ].join("\n");
}

function edgeCell(
  id: string,
  edge: GraphEdge,
  source: string,
  target: string,
): string {
  return [
    `        <mxCell id="${id}" value="${escapeAttribute(escapeHtml(EDGE_LABEL[edge.kind]))}" style="${EDGE_STYLE[edge.kind]}" edge="1" parent="1" source="${source}" target="${target}">`,
    '          <mxGeometry relative="1" as="geometry" />',
    "        </mxCell>",
  ].join("\n");
}

/**
 * 起動関係のグラフを、draw.ioのXMLにする。
 * 同じグラフからは同じ文字列を返す。辺の両端が存在しない辺は描かない。
 */
export function flowGraphToDrawioXml(graph: FlowGraph): string {
  const columns = orderColumns(graph);
  const cellIds = new Map<string, string>();
  const vertices: string[] = [];
  let count = 0;
  columns.forEach((column, columnIndex) => {
    column.forEach((node, row) => {
      const id = `n${count}`;
      count += 1;
      cellIds.set(node.id, id);
      vertices.push(vertexCell(id, node, columnIndex, row));
    });
  });

  const edges: string[] = [];
  graph.edges.forEach((edge, index) => {
    const source = cellIds.get(edge.from);
    const target = cellIds.get(edge.to);
    if (source === undefined || target === undefined) return;
    edges.push(edgeCell(`e${index}`, edge, source, target));
  });

  return [
    '<mxfile host="app.diagrams.net">',
    '  <diagram name="flow-launch-graph" id="flow-launch-graph">',
    '    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1100" pageHeight="1100" math="0" shadow="0">',
    "      <root>",
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    ...vertices,
    ...edges,
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
    "",
  ].join("\n");
}
