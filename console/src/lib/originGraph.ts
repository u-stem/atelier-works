// 起動の図の組み立て。定期ジョブから前進の辺(起動と承認)でたどれるflowを段に並べ、箱と線の座標を決める純関数。
// 語は`screens/jobs/OriginDiagram.tsx`が表示する。

import { type Box, exitText, MARGIN, type Point } from "./flowDiagram.ts";
import {
  type ExitVia,
  type FlowDefinition,
  type FlowExit,
  type FlowsData,
  findSchedule,
} from "./flowsData.ts";

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
  /** 起点が直接起動するflow。重複しない。 */
  readonly launched: readonly string[];
  /** 段、同じ段の中では見つけた順に並ぶ。 */
  readonly nodes: readonly OriginFlowNode[];
  readonly edges: readonly OriginEdge[];
  /** 起点の箱を含む段の数。 */
  readonly columns: number;
  /** 承認の線か、戻りの注記があり、設定や試行の上限で起動しないことがある。 */
  readonly conditional: boolean;
};

/** そのflow自身へ戻る出口に書く文。 */
const SELF_TEXT = "やり直し";

function isForwardVia(via: ExitVia): via is "launch" | "approve" {
  return via === "launch" || via === "approve";
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** flowから前進の辺でつながる行き先。flow自身は含まない。 */
function forwardTargets(flow: FlowDefinition): string[] {
  return unique(
    flow.exits
      .filter((exit) => isForwardVia(exit.via) && exit.flow !== flow.name)
      .map((exit) => exit.flow),
  );
}

function exitsOf(
  flow: FlowDefinition,
  demoted: ReadonlySet<string>,
): OriginExit[] {
  const seen = new Set<string>();
  const result: OriginExit[] = [];
  for (const exit of flow.exits) {
    const key = `${exit.via} ${exit.flow}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const self = exit.flow === flow.name;
    result.push({
      via: exit.via,
      to: exit.flow,
      self,
      drawn:
        !self && isForwardVia(exit.via) && !demoted.has(edgeKey(flow, exit)),
      step: exit.step,
      text: self ? SELF_TEXT : exitText(exit),
    });
  }
  return result;
}

function edgeKey(flow: FlowDefinition, exit: FlowExit): string {
  return `${flow.name}>${exit.flow}`;
}

/**
 * 起動の図を組み立てる。`scheduleName`のscheduleが無ければ`null`にする。
 * - 描くflowは、起点から前進の辺(起動と承認)でたどれるものに限る。差し戻しと却下の先でしか届かないflowは描かない。
 * - 段は、前進の辺だけを使った、起点からの最長の経路で決める。
 * - 前進の辺が循環していても止まる。循環を閉じる辺は線にせず、注記にする。
 * - 戻りは線にせず、足の注記にする。そのflow自身へ戻る出口は「やり直し」と書く。
 */
export function originGraphModel(
  data: FlowsData,
  scheduleName: string,
): OriginGraphModel | null {
  const schedule = findSchedule(data, scheduleName);
  if (schedule === null) return null;
  const byName = new Map(data.flows.map((flow) => [flow.name, flow]));
  const launched = unique(schedule.flows).filter((name) => byName.has(name));

  const targetsOf = (name: string): string[] => {
    const flow = byName.get(name);
    return flow === undefined
      ? []
      : forwardTargets(flow).filter((to) => byName.has(to));
  };

  const discovered: string[] = [];
  const queue = [...launched];
  for (const name of queue) {
    if (discovered.includes(name)) continue;
    discovered.push(name);
    queue.push(...targetsOf(name));
  }

  const demoted = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const finished: string[] = [];
  const visit = (name: string): void => {
    state.set(name, "visiting");
    for (const to of targetsOf(name)) {
      const next = state.get(to);
      if (next === "visiting") {
        demoted.add(`${name}>${to}`);
      } else if (next === undefined) {
        visit(to);
      }
    }
    state.set(name, "done");
    finished.push(name);
  };
  for (const name of launched) {
    if (!state.has(name)) visit(name);
  }

  const column = new Map<string, number>(launched.map((name) => [name, 1]));
  for (const name of [...finished].reverse()) {
    const own = column.get(name) ?? 1;
    for (const to of targetsOf(name)) {
      if (demoted.has(`${name}>${to}`)) continue;
      column.set(to, Math.max(column.get(to) ?? 0, own + 1));
    }
  }

  const nodes = discovered
    .flatMap((name): OriginFlowNode[] => {
      const flow = byName.get(name);
      return flow === undefined
        ? []
        : [
            {
              flow,
              column: column.get(name) ?? 1,
              exits: exitsOf(flow, demoted),
            },
          ];
    })
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.column - b.node.column || a.index - b.index)
    .map((entry) => entry.node);

  const edges: OriginEdge[] = launched.map((name) => ({
    from: null,
    to: name,
    via: "launch",
    step: null,
    span: column.get(name) ?? 1,
  }));
  for (const node of nodes) {
    for (const exit of node.exits) {
      if (!exit.drawn || !isForwardVia(exit.via)) continue;
      edges.push({
        from: node.flow.name,
        to: exit.to,
        via: exit.via,
        step: exit.step,
        span: (column.get(exit.to) ?? 1) - node.column,
      });
    }
  }

  return {
    origin: { name: schedule.name, summary: schedule.summary },
    launched,
    nodes,
    edges,
    columns: nodes.reduce((max, node) => Math.max(max, node.column), 0) + 1,
    conditional: nodes.some((node) =>
      node.exits.some((exit) => !exit.drawn || exit.via === "approve"),
    ),
  };
}

/** 足の注記にする出口。 */
export function footNotes(node: OriginFlowNode): readonly OriginExit[] {
  return node.exits.filter((exit) => !exit.drawn);
}

/**
 * 初めから開いておくflow。起点が起動するflowが1つだけのときは、そのflowを開く。
 * 開かないと、確かめたい中身まで、必ず1回押すことになるためである。
 */
export function initialExpanded(model: OriginGraphModel): ReadonlySet<string> {
  const [only, ...rest] = model.launched;
  return only !== undefined && rest.length === 0 ? new Set([only]) : new Set();
}

export const ORIGIN_WIDTH = 180;
export const ORIGIN_HEIGHT = 112;
export const NODE_WIDTH = 200;
export const COLUMN_GAP = 96;
/** 箱の上端から、見出し(flow名、説明、ステップ数、開閉の印)の下端まで。 */
export const NODE_HEADER_HEIGHT = 64;
export const STEP_ROW_HEIGHT = 40;
/** ステップの行の間の、細い矢印を引く間隔。 */
const STEP_ROW_GAP = 12;
const BODY_PAD = 8;
export const LINK_ROW_HEIGHT = 24;
export const NOTE_ROW_HEIGHT = 18;
const NOTES_PAD = 8;
const NODE_GAP = 24;
/** 段を飛ぶ線を、箱の下端から離して引く最初の間隔と、線同士の間隔。 */
const LANE_FIRST = 20;
const LANE_GAP = 14;
/** 段を飛ぶ線が、箱の右辺と左辺から出入りする水平の長さと、線ごとのずらし。 */
const BEND = 16;
const BEND_STEP = 6;

export type OriginStepRow = {
  readonly id: string;
  /** 行の上端。 */
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
  /** 「flowの図」のリンクの行の上端。たたんだときは`null`。 */
  readonly linkY: number | null;
  /** 足の注記の行。`y`は行の上端。 */
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

function layoutNode(
  node: OriginFlowNode,
  open: boolean,
  x: number,
  y: number,
): OriginNodeLayout {
  let bottom = y + NODE_HEADER_HEIGHT;
  const steps: OriginStepRow[] = [];
  let linkY: number | null = null;
  if (open) {
    let top = bottom + BODY_PAD;
    for (const step of node.flow.steps) {
      steps.push({ id: step.id, y: top, height: STEP_ROW_HEIGHT });
      top += STEP_ROW_HEIGHT + STEP_ROW_GAP;
    }
    linkY = top - STEP_ROW_GAP + BODY_PAD;
    bottom = linkY + LINK_ROW_HEIGHT + BODY_PAD;
  }
  const texts = footNotes(node).map((note) => note.text);
  const notes = texts.map((text, index) => ({
    text,
    y: bottom + NOTES_PAD + index * NOTE_ROW_HEIGHT,
  }));
  if (texts.length > 0) {
    bottom += NOTES_PAD + texts.length * NOTE_ROW_HEIGHT + NOTES_PAD;
  }
  return {
    flow: node.flow.name,
    column: node.column,
    expanded: open,
    x,
    y,
    width: NODE_WIDTH,
    height: bottom - y,
    headerHeight: NODE_HEADER_HEIGHT,
    steps,
    linkY,
    notes,
  };
}

/**
 * 起動の図の配置を決める。左端に起点の箱を置き、右へ段ごとにflowを縦に積む。
 * ノードの幅は開閉で変えない。変えると、図の幅が変わって見せ方が入れ替わり、押したボタンが消えてフォーカスを失うためである。
 * 隣り合う段を結ぶ線は、右辺から左辺へ直線で引く。段を飛ぶ線は、箱の下端の下に引いた通り道を回し、間の段の箱の上を通さない。
 * 線の出る位置は、たたんだノードでは見出しの高さ、開いたノードでは出口のつくステップの行の高さとする。
 */
export function layoutOriginGraph(
  model: OriginGraphModel,
  expanded: ReadonlySet<string>,
): OriginLayout {
  const origin: Box = {
    x: MARGIN,
    y: MARGIN,
    width: ORIGIN_WIDTH,
    height: ORIGIN_HEIGHT,
  };
  const columnX = (column: number): number =>
    MARGIN +
    ORIGIN_WIDTH +
    COLUMN_GAP +
    (column - 1) * (NODE_WIDTH + COLUMN_GAP);
  const tops = new Map<number, number>();
  const nodes = model.nodes.map((node) => {
    const top = tops.get(node.column) ?? MARGIN;
    const layout = layoutNode(
      node,
      expanded.has(node.flow.name),
      columnX(node.column),
      top,
    );
    tops.set(node.column, top + layout.height + NODE_GAP);
    return layout;
  });

  const bottom = Math.max(
    origin.y + origin.height,
    ...nodes.map((node) => node.y + node.height),
  );
  const byName = new Map(nodes.map((node) => [node.flow, node]));

  let lanes = 0;
  const edges = model.edges.flatMap((edge): OriginEdgeLayout[] => {
    const target = byName.get(edge.to);
    if (target === undefined) return [];
    const node = edge.from === null ? undefined : byName.get(edge.from);
    if (edge.from !== null && node === undefined) return [];
    const source: Box = node ?? origin;
    const row = node?.steps.find((step) => step.id === edge.step);
    const start: Point = {
      x: source.x + source.width,
      y:
        row !== undefined
          ? row.y + row.height / 2
          : node !== undefined
            ? node.y + node.headerHeight / 2
            : source.y + source.height / 2,
    };
    const end: Point = {
      x: target.x,
      y: target.y + target.headerHeight / 2,
    };
    const word = edge.via === "approve";
    if (edge.span <= 1) {
      return [
        {
          edge,
          points: [start, end],
          label: word
            ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4 }
            : null,
        },
      ];
    }
    const lane = bottom + LANE_FIRST + lanes * LANE_GAP;
    const out = start.x + BEND + lanes * BEND_STEP;
    const into = end.x - BEND - lanes * BEND_STEP;
    lanes += 1;
    return [
      {
        edge,
        points: [
          start,
          { x: out, y: start.y },
          { x: out, y: lane },
          { x: into, y: lane },
          { x: into, y: end.y },
          end,
        ],
        label: word ? { x: (out + into) / 2, y: lane - 4 } : null,
      },
    ];
  });

  const flowColumns = nodes.reduce(
    (max, node) => Math.max(max, node.column),
    0,
  );
  return {
    origin,
    nodes,
    edges,
    width:
      MARGIN + ORIGIN_WIDTH + flowColumns * (COLUMN_GAP + NODE_WIDTH) + MARGIN,
    height:
      (lanes === 0 ? bottom : bottom + LANE_FIRST + (lanes - 1) * LANE_GAP) +
      MARGIN,
  };
}
