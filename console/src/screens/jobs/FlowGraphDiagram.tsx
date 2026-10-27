import { Clock } from "lucide-react";
import { useId, useMemo } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import type {
  FlowGraph,
  GraphEdgeKind,
  GraphNodeKind,
} from "../../lib/flowGraph.ts";
import {
  type GraphPresentation,
  textEm,
  wrapLines,
} from "../../lib/flowGraphFit.ts";
import {
  type LayoutBox,
  type LayoutLink,
  layoutExtent,
  layoutFlowGraph,
} from "../../lib/flowGraphLayout.ts";
import {
  type FlowGraphState,
  type NodeActivity,
  nodeLinkTarget,
} from "../../lib/flowOverlay.ts";
import { jobDetailPath } from "../../lib/jobLink.ts";
import { safeText } from "../../lib/safeText.ts";
import {
  activityWords,
  type ScheduleWords,
  scheduleWords,
} from "./flowGraphText.ts";
import { JobStateBadge } from "./JobRows.tsx";

/** 図のノード1つ分のデータ。 */
type GraphNodeData = FlowGraph["nodes"][number];

/** 箱の左右の余白(px)。文字はこの内側に収める。 */
const PAD_X = 10;
/** 箱の幅に収める文字数(em)。名前は12px、補足は11pxで描く。 */
const LABEL_EM = 15;
/** 名前を12pxから11pxに落とすと、同じ幅に入る文字が増える割合。 */
const LABEL_SHRINK_RATIO = 12 / 11;
const NOTE_EM = 16;
/** 行の送り(px)と、箱の下端から語の行までの余白(px)。 */
const LINE_STEP = 14;
const LABEL_BASELINE = 17;
const WORDS_BOTTOM = 9;
/** 実行中の記号の幅(px)と、「実行中」の後に待ちの語を置く位置(記号、語3字、間)。 */
const RUNNING_MARK_WIDTH = 12;
const QUEUED_AFTER_RUNNING = RUNNING_MARK_WIDTH + 36 + 10;

/** 辺の線の種類。実線はscriptがflowを起動する関係、破線は時刻と人の操作による起動、点線はflowのステップ。 */
const EDGE_DASH: Readonly<Record<GraphEdgeKind, string | undefined>> = {
  run: undefined,
  schedule: "6 4",
  human: "6 4",
  step: "2 4",
};

/** 箱の面の色。種類を見分ける助けで、意味は添える語が持つ。色はすべてトークンから取る。 */
const NODE_FILL: Readonly<Record<GraphNodeKind, string>> = {
  flow: "fill-card",
  script: "fill-muted",
  schedule: "fill-accent",
  human: "fill-accent",
};

function Edge({ link, markerId }: { link: LayoutLink; markerId: string }) {
  const dash = EDGE_DASH[link.edge.kind];
  const midX = (link.exit.x + link.entry.x) / 2;
  const midY = (link.exit.y + link.entry.y) / 2;
  return (
    <g>
      <line
        x1={link.exit.x}
        y1={link.exit.y}
        x2={link.entry.x}
        y2={link.entry.y}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd={`url(#${markerId})`}
        {...(dash === undefined ? {} : { strokeDasharray: dash })}
      />
      {link.edge.kind === "step" ? (
        <text
          x={midX}
          y={midY - 4}
          textAnchor="middle"
          className="fill-subtle text-[10px]"
        >
          ステップ
        </text>
      ) : null}
    </g>
  );
}

/** 実行中を示す三角の記号。形でも見分けられるよう、語の左に並べる。 */
function RunningMark({ x, y }: { x: number; y: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 図形は焦点を受けない。装飾の記号を読み上げから外す。
    <polygon
      aria-hidden="true"
      points={`${x},${y - 9} ${x + 8},${y - 4.5} ${x},${y}`}
      className="fill-primary"
    />
  );
}

function NodeBody({
  box,
  activity,
  lowerBound,
  schedule,
}: {
  box: LayoutBox;
  activity: NodeActivity | undefined;
  lowerBound: boolean;
  schedule: ScheduleWords;
}) {
  const { node } = box;
  const words =
    node.kind === "flow" ? activityWords(activity, lowerBound) : null;
  const running = words?.running != null;
  const noteLines = node.kind === "flow" ? 2 : 1;
  const labelText = safeText(node.label);
  // 12pxで箱に収まらない名前は、11pxに落として全体を見せる。それでも収まらなければ切る。
  const shrink = textEm(labelText) > LABEL_EM;
  const label = wrapLines(
    labelText,
    shrink ? LABEL_EM * LABEL_SHRINK_RATIO : LABEL_EM,
    1,
  );
  const note = wrapLines(safeText(node.note), NOTE_EM, noteLines);
  const wordsY = box.y + box.height - WORDS_BOTTOM;
  const textX = box.x + PAD_X;
  return (
    <>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={node.kind === "flow" ? 10 : 6}
        strokeWidth={running ? 2.5 : 1}
        className={cn(
          running
            ? "fill-selected stroke-primary"
            : cn(NODE_FILL[node.kind], "stroke-edge"),
        )}
      />
      <text
        x={textX}
        y={box.y + LABEL_BASELINE}
        className={cn(
          "fill-foreground font-semibold",
          shrink ? "text-[11px]" : "text-caption",
        )}
      >
        {label.join("")}
      </text>
      {note.map((line, index) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びだけで決まり、入れ替わらない。
          key={index}
          x={textX}
          y={box.y + LABEL_BASELINE + LINE_STEP * (index + 1)}
          className="fill-muted-foreground text-[11px]"
        >
          {line}
        </text>
      ))}
      {words?.running == null ? null : (
        <>
          <RunningMark x={textX} y={wordsY} />
          <text
            x={textX + RUNNING_MARK_WIDTH}
            y={wordsY}
            className="fill-primary text-caption font-semibold"
          >
            {words.running}
          </text>
        </>
      )}
      {words?.queued == null ? null : (
        <text
          x={textX + (words.running === null ? 0 : QUEUED_AFTER_RUNNING)}
          y={wordsY}
          className="fill-foreground text-caption font-semibold"
        >
          {words.queued}
        </text>
      )}
      {schedule.last === null ? null : (
        <text
          x={textX}
          y={wordsY}
          className={cn(
            "text-[11px] font-semibold",
            schedule.stopped
              ? "fill-muted-foreground"
              : schedule.last.includes("失敗")
                ? "fill-failure"
                : "fill-success",
          )}
        >
          {schedule.last}
        </text>
      )}
      {schedule.next === null ? null : (
        <text
          x={
            textX +
            (schedule.last === null ? 0 : textEm(schedule.last) * 11 + 8)
          }
          y={wordsY}
          className="fill-muted-foreground text-[11px]"
        >
          {schedule.next}
        </text>
      )}
    </>
  );
}

/**
 * ノードの移動先。`runningLinksOnly`のとき、flowの箱は実行中のジョブの詳細へ移るときだけリンクにする。
 * 動いていないflowの箱が、そのflowの全作業項目の履歴へ移ると、1件の作業項目の図から他の作業項目へ飛ぶためである。
 */
function linkOf(
  node: GraphNodeData,
  activity: NodeActivity | undefined,
  runningLinksOnly: boolean,
): string | null {
  if (runningLinksOnly && node.kind === "flow") {
    return jobDetailPath(activity?.runningJobId);
  }
  return nodeLinkTarget(node, activity);
}

/** 箱1つ。移る先があればリンクにして、キーボードで届くようにする。 */
function GraphNode({
  box,
  state,
  lowerBound,
  runningLinksOnly,
}: {
  box: LayoutBox;
  state: FlowGraphState;
  lowerBound: boolean;
  runningLinksOnly: boolean;
}) {
  const activity = state.overlay?.activity.get(box.node.id);
  const to = linkOf(box.node, activity, runningLinksOnly);
  const body = (
    <NodeBody
      box={box}
      activity={activity}
      lowerBound={lowerBound}
      schedule={scheduleWords(state.scheduleEntries?.get(box.node.id))}
    />
  );
  return to === null ? (
    <g>{body}</g>
  ) : (
    <Link to={to} className={LINK_CLASS}>
      {body}
    </Link>
  );
}

/** 図の読み上げの名前の既定。 */
const DIAGRAM_LABEL = "起動の関係の図";

const LINK_CLASS =
  "outline-none [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3px]";

/**
 * 起動の関係の図。配置は`layoutFlowGraph`が決め、箱と辺を自前のSVGで描く。
 * 色はすべてCSSのトークンで指定するので、ライトとダークの両方で読める。
 * 実行中のflowは、面と枠を強調し、「実行中」の語と記号を添える。待ちは「待ちN」と書く。強調は色だけに頼らない。
 * flowの箱は、実行中のジョブか履歴へのリンク、scheduleの箱はスケジュールのタブへのリンクで、キーボードで届く。
 * scheduleの箱には、直近の実行の成否を語で添える。
 * 取得に失敗した間は、`state`の重ねる情報が`null`になり、強調も添え書きも出さない。
 */
export function FlowGraphDiagram({
  graph,
  state,
  label = DIAGRAM_LABEL,
  compact = false,
  runningLinksOnly = false,
}: {
  graph: FlowGraph;
  state: FlowGraphState;
  /** 図の読み上げの名前。 */
  label?: string;
  /** 左端の空の列を詰める。経路だけを切り出した小さなグラフに使う。 */
  compact?: boolean;
  /** flowの箱を、実行中のジョブへのリンクだけにする。 */
  runningLinksOnly?: boolean;
}) {
  const layout = useMemo(
    () => layoutFlowGraph(graph, { compact }),
    [graph, compact],
  );
  const extent = layoutExtent(layout);
  const markerId = `flow-arrow-${useId().replace(/:/g, "")}`;
  const lowerBound = state.overlay?.lowerBound ?? false;
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVGの中にfieldsetは置けない。リンクを含む図なので、imgにもできない。
    <svg
      role="group"
      aria-label={label}
      width={extent.width}
      height={extent.height}
      viewBox={`0 0 ${extent.width} ${extent.height}`}
      className="block max-w-none"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX={10}
          refY={5}
          markerWidth={8}
          markerHeight={8}
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {layout.links.map((link) => (
        <Edge
          key={`${link.edge.from} ${link.edge.to}`}
          link={link}
          markerId={markerId}
        />
      ))}
      {layout.boxes.map((box) => (
        <GraphNode
          key={box.node.id}
          box={box}
          state={state}
          lowerBound={lowerBound}
          runningLinksOnly={runningLinksOnly}
        />
      ))}
    </svg>
  );
}

/**
 * 図を、節の幅に合わせた見せ方で包む。
 * 収まるときはカードに入れて図をそのまま、収まらないときは横にスクロールできる枠に入れる。
 * 枠は、キーボードで焦点を当てないと隠れた部分を読めないので、焦点を受けられるようにする。
 * 幅が狭く図が読めないときは、図の代わりに、flowごとの一覧を出す。
 */
export function FlowGraphFrame({
  graph,
  state,
  presentation,
  label = DIAGRAM_LABEL,
  compact = false,
  runningLinksOnly = false,
}: {
  graph: FlowGraph;
  state: FlowGraphState;
  presentation: GraphPresentation;
  label?: string;
  compact?: boolean;
  runningLinksOnly?: boolean;
}) {
  if (presentation === "list") {
    return (
      <FlowGraphList
        graph={graph}
        state={state}
        runningLinksOnly={runningLinksOnly}
      />
    );
  }
  const diagram = (
    <FlowGraphDiagram
      graph={graph}
      state={state}
      label={label}
      compact={compact}
      runningLinksOnly={runningLinksOnly}
    />
  );
  if (presentation === "fit") {
    return (
      <div className="rounded-xl border border-border bg-card p-2">
        {diagram}
      </div>
    );
  }
  return (
    // 横にスクロールできる領域は、キーボードで焦点を当てないと読み進められない。
    // biome-ignore lint/a11y/useSemanticElements: 領域の役割を明示する。sectionは、見出しを持つ節と取り違えられる。
    <div
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上。
      tabIndex={0}
      aria-label={`${label}(横にスクロールできます)`}
      className="overflow-x-auto rounded-xl border border-border bg-card p-2 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {diagram}
    </div>
  );
}

/**
 * 図が読めない狭い幅の代わりの一覧。flowごとに名前(リンク)と、実行中と待ちを語で示す。
 * 起動の関係の辺は出さない。実行の状態を読むための一覧である。
 */
export function FlowGraphList({
  graph,
  state,
  runningLinksOnly = false,
}: {
  graph: FlowGraph;
  state: FlowGraphState;
  runningLinksOnly?: boolean;
}) {
  const flows = graph.nodes.filter((node) => node.kind === "flow");
  const lowerBound = state.overlay?.lowerBound ?? false;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {flows.map((node) => {
        const activity = state.overlay?.activity.get(node.id);
        const words = activityWords(activity, lowerBound);
        const to = linkOf(node, activity, runningLinksOnly);
        const name = safeText(node.label);
        return (
          <li
            key={node.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-small"
          >
            {to === null ? (
              <span className="min-w-0 font-medium break-all">{name}</span>
            ) : (
              <Link
                to={to}
                className="min-w-0 rounded-sm font-medium break-all underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {name}
              </Link>
            )}
            {words.running === null ? null : <JobStateBadge state="running" />}
            {words.queued === null ? null : (
              <Badge variant="muted">
                <Clock aria-hidden="true" />
                {words.queued}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
