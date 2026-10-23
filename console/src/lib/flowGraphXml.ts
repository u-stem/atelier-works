// 起動関係のグラフから、draw.ioの非圧縮XMLを組み立てる純関数。
// 配置は`flowGraphLayout.ts`が決める。
// ノードは機械生成の全体の見取り図で、drawio-diagramスキルの目安(15個)を超える。
// 分割すると、起動の経路を1枚で追うという目的を失うので、1枚にまとめる。
// 図は信頼できない入力として隔離したiframeで描くので、リンク、`placeholders`、
// ラベルのHTMLの属性は出さない。ラベルは、HTMLの文字としてエスケープした後、
// XMLの属性値としてもう一度エスケープする。

import type {
  FlowGraph,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
} from "./flowGraph.ts";
import {
  type Anchor,
  type LayoutBox,
  type LayoutLink,
  layoutFlowGraph,
} from "./flowGraphLayout.ts";

const NODE_STYLE: Readonly<Record<GraphNodeKind, string>> = {
  schedule:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;",
  human:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;",
  script:
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
  flow: "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
};

/**
 * 辺は直線で引く(経路を決める`edgeStyle`を付けない)。
 * 実線はscriptがflowを起動する関係、破線は時刻と人の操作による起動、点線はflowの中のステップ。
 */
const EDGE_BASE = "html=1;endArrow=block;";
const EDGE_STYLE: Readonly<Record<GraphEdgeKind, string>> = {
  run: `${EDGE_BASE}strokeColor=#333333;`,
  schedule: `${EDGE_BASE}dashed=1;strokeColor=#b09500;`,
  human: `${EDGE_BASE}dashed=1;strokeColor=#d79b00;`,
  step: `${EDGE_BASE}dashed=1;dashPattern=1 3;strokeColor=#9673a6;fontColor=#9673a6;`,
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

function vertexCell(id: string, box: LayoutBox): string {
  return [
    `        <mxCell id="${id}" value="${labelValue(box.node)}" style="${NODE_STYLE[box.node.kind]}" vertex="1" parent="1">`,
    `          <mxGeometry x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" as="geometry" />`,
    "        </mxCell>",
  ].join("\n");
}

function constraint(prefix: "exit" | "entry", anchor: Anchor): string {
  const x = anchor.side === "right" ? 1 : 0;
  return `${prefix}X=${x};${prefix}Y=${anchor.fraction};${prefix}Dx=0;${prefix}Dy=0;`;
}

function edgeCell(
  id: string,
  link: LayoutLink,
  source: string,
  target: string,
): string {
  const style = `${EDGE_STYLE[link.edge.kind]}${constraint("exit", link.exit)}${constraint("entry", link.entry)}`;
  return [
    `        <mxCell id="${id}" value="${escapeAttribute(escapeHtml(EDGE_LABEL[link.edge.kind]))}" style="${style}" edge="1" parent="1" source="${source}" target="${target}">`,
    '          <mxGeometry relative="1" as="geometry" />',
    "        </mxCell>",
  ].join("\n");
}

/**
 * 起動関係のグラフを、draw.ioのXMLにする。
 * 同じグラフからは同じ文字列を返す。辺のidは、グラフの辺の並びの番号に合わせる。
 */
export function flowGraphToDrawioXml(graph: FlowGraph): string {
  const layout = layoutFlowGraph(graph);
  const cellIds = new Map<string, string>();
  const vertices = layout.boxes.map((box, index) => {
    const id = `n${index}`;
    cellIds.set(box.node.id, id);
    return vertexCell(id, box);
  });

  const edges: string[] = [];
  graph.edges.forEach((edge, index) => {
    const link = layout.links.find((candidate) => candidate.edge === edge);
    const source = cellIds.get(edge.from);
    const target = cellIds.get(edge.to);
    if (link === undefined || source === undefined || target === undefined) {
      return;
    }
    edges.push(edgeCell(`e${index}`, link, source, target));
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
