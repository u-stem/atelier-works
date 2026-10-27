import { useId, useMemo } from "react";
import { Link } from "react-router";
import { JobLink } from "../../components/JobLink.tsx";
import { cn } from "../../lib/cn.ts";
import {
  CONDITIONAL_EDGES_NOTE,
  CONDITIONAL_WORD,
  type DiagramBox,
  type DiagramLayout,
  type DiagramLink,
  diagramLabel,
  entryText,
  exitKey,
  exitLinkLabel,
  exitOriginText,
  exitText,
  type FlowDiagramModel,
  groupEntriesForList,
  hasConditionalEdges,
  isSelfExit,
  layoutFlowDiagram,
  type StepNode,
  stepLinkLabel,
  UNKNOWN_STEPS_HEADING,
  unwiredText,
} from "../../lib/flowDiagram.ts";
import { type GraphPresentation, wrapLines } from "../../lib/flowGraphFit.ts";
import type { FlowEntry } from "../../lib/flowsData.ts";
import { flowDiagramPath } from "../../lib/flowsData.ts";
import { jobDetailPath } from "../../lib/jobLink.ts";
import type { JobStateKind } from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { StepList } from "./JobDetailParts.tsx";
import { StepStateBadge } from "./JobRows.tsx";

/** 箱の左右の余白(px)。 */
const PAD_X = 10;
/** 箱に収める文字数(em)。説明は12px、IDと添え書きは11pxで描く。 */
const SUMMARY_EM = 11;
const ID_EM = 11.5;
const SIDE_EM = 13.5;
const LINE_STEP = 14;
const LABEL_BASELINE = 17;
/** ステップの箱の中の、IDと添え書きと状態の行の位置(箱の上端から)。 */
const ID_Y = 50;
const CONDITIONAL_Y = 65;
const STATE_Y = 85;

const LINK_CLASS =
  "outline-none [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3px]";

/** 線の種類。入口は破線、ステップの間は実線、出口は点線。 */
const LINK_DASH: Readonly<Record<DiagramLink["kind"], string | undefined>> = {
  entry: "6 4",
  next: undefined,
  exit: "2 4",
};

/** 状態の語の色。色は語と記号に添える補助で、意味は語が持つ。 */
const STATE_FILL: Readonly<Record<JobStateKind, string>> = {
  success: "fill-success",
  failure: "fill-failure",
  running: "fill-primary",
  queued: "fill-foreground",
  scheduled: "fill-muted-foreground",
  canceled: "fill-warning",
  skipped: "fill-muted-foreground",
  unknown: "fill-muted-foreground",
};

function Arrow({ link, markerId }: { link: DiagramLink; markerId: string }) {
  const dash = LINK_DASH[link.kind];
  return (
    <line
      x1={link.from.x}
      y1={link.from.y}
      x2={link.to.x}
      y2={link.to.y}
      className="stroke-muted-foreground"
      strokeWidth={1.5}
      markerEnd={`url(#${markerId})`}
      {...(dash === undefined ? {} : { strokeDasharray: dash })}
    />
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

/** 失敗を示す×の記号。 */
function FailureMark({ x, y }: { x: number; y: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 図形は焦点を受けない。装飾の記号を読み上げから外す。
    <path
      aria-hidden="true"
      d={`M${x},${y - 8} L${x + 8},${y} M${x + 8},${y - 8} L${x},${y}`}
      className="fill-none stroke-failure"
      strokeWidth={1.8}
    />
  );
}

/** 成功を示すチェックの記号。 */
function SuccessMark({ x, y }: { x: number; y: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 図形は焦点を受けない。装飾の記号を読み上げから外す。
    <path
      aria-hidden="true"
      d={`M${x},${y - 4} L${x + 3},${y - 1} L${x + 8},${y - 8}`}
      className="fill-none stroke-success"
      strokeWidth={1.8}
    />
  );
}

const MARK_WIDTH = 12;

function StateWords({ node, x, y }: { node: StepNode; x: number; y: number }) {
  if (node.state === null) return null;
  const { kind, label } = node.state;
  const mark =
    kind === "running" ? (
      <RunningMark x={x} y={y} />
    ) : kind === "failure" ? (
      <FailureMark x={x} y={y} />
    ) : kind === "success" ? (
      <SuccessMark x={x} y={y} />
    ) : null;
  return (
    <>
      {mark}
      <text
        x={x + (mark === null ? 0 : MARK_WIDTH)}
        y={y}
        className={cn("text-caption font-semibold", STATE_FILL[kind])}
      >
        {safeText(label)}
      </text>
    </>
  );
}

function StepBody({
  box,
  node,
  overlay,
}: {
  box: Extract<DiagramBox, { kind: "step" }>;
  node: StepNode;
  overlay: boolean;
}) {
  const x = box.x + PAD_X;
  const summary = wrapLines(safeText(node.step.summary), SUMMARY_EM, 2);
  const id = wrapLines(safeText(node.step.id), ID_EM, 1).join("");
  return (
    <>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={10}
        strokeWidth={node.running ? 2.5 : 1}
        className={
          node.running
            ? "fill-selected stroke-primary"
            : "fill-card stroke-input"
        }
      />
      {summary.map((line, index) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びだけで決まり、入れ替わらない。
          key={index}
          x={x}
          y={box.y + LABEL_BASELINE + LINE_STEP * index}
          className="fill-foreground text-caption font-semibold"
        >
          {line}
        </text>
      ))}
      <text
        x={x}
        y={box.y + ID_Y}
        className="fill-muted-foreground font-mono text-[11px]"
      >
        {id}
      </text>
      {overlay && node.step.conditional ? (
        <text
          x={x}
          y={box.y + CONDITIONAL_Y}
          className="fill-muted-foreground text-[11px]"
        >
          {CONDITIONAL_WORD}
        </text>
      ) : null}
      <StateWords node={node} x={x} y={box.y + STATE_Y} />
    </>
  );
}

/** 入口と出口の箱。文を折り返して描く。 */
function SideBody({ box, text }: { box: DiagramBox; text: string }) {
  const lines = wrapLines(
    safeText(text),
    SIDE_EM,
    box.kind === "entry" ? 3 : 2,
  );
  return (
    <>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        strokeWidth={1}
        className={cn(
          "stroke-input",
          box.kind === "entry" ? "fill-accent" : "fill-card",
        )}
      />
      {lines.map((line, index) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びだけで決まり、入れ替わらない。
          key={index}
          x={box.x + PAD_X}
          y={box.y + LABEL_BASELINE + LINE_STEP * index}
          className="fill-foreground text-[11px]"
        >
          {line}
        </text>
      ))}
    </>
  );
}

/** 箱1つ。移る先があればリンクにして、キーボードで届くようにする。 */
function BoxView({ box, overlay }: { box: DiagramBox; overlay: boolean }) {
  if (box.kind === "entry") {
    return (
      <g>
        <SideBody box={box} text={entryText(box.entry)} />
      </g>
    );
  }
  if (box.kind === "exit") {
    const text = exitText(box.exit);
    const to = flowDiagramPath(box.exit.flow);
    const body = <SideBody box={box} text={text} />;
    const name = safeText(exitLinkLabel(box.exit));
    return to === null ? (
      <g>{body}</g>
    ) : (
      <Link to={to} aria-label={name} className={LINK_CLASS}>
        {body}
      </Link>
    );
  }
  const to = jobDetailPath(box.node.jobId);
  const body = <StepBody box={box} node={box.node} overlay={overlay} />;
  const name = safeText(stepLinkLabel(box.node.step));
  return to === null ? (
    <g>{body}</g>
  ) : (
    <Link to={to} aria-label={name} className={LINK_CLASS}>
      {body}
    </Link>
  );
}

/**
 * flowの図。配置は`layoutFlowDiagram`が決め、箱と線を自前のSVGで描く。
 * 色はすべてCSSのトークンで指定するので、ライトとダークの両方で読める。
 * 実行中のステップは、面と枠を強調し、「実行中」の語と記号を添える。失敗は×、成功はチェックの記号を添える。強調は色だけに頼らない。
 * 出口は次のflowの図へ、子のジョブを持つステップはそのジョブの詳細へのリンクで、キーボードで届く。
 */
function FlowDiagram({
  layout,
  label,
  overlay,
}: {
  layout: DiagramLayout;
  label: string;
  overlay: boolean;
}) {
  const markerId = `flow-arrow-${useId().replace(/:/g, "")}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVGの中にfieldsetは置けない。リンクを含む図なので、imgにもできない。
    <svg
      role="group"
      aria-label={label}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
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
        <Arrow
          key={`${link.kind} ${link.from.x},${link.from.y} ${link.to.x},${link.to.y}`}
          link={link}
          markerId={markerId}
        />
      ))}
      {layout.boxes.map((box, index) => (
        <BoxView
          // biome-ignore lint/suspicious/noArrayIndexKey: 箱は配置の順で決まり、入れ替わらない。
          key={index}
          box={box}
          overlay={overlay}
        />
      ))}
    </svg>
  );
}

const SECTION_LABEL = "text-caption font-semibold text-muted-foreground";

const LIST_LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** flowの名前。図の画面があればリンクにする。 */
function FlowNameLink({ name }: { name: string }) {
  const to = flowDiagramPath(name);
  const text = safeText(name);
  return to === null ? (
    <>{text}</>
  ) : (
    <Link to={to} className={LIST_LINK_CLASS}>
      {text}
    </Link>
  );
}

/** 入口1つ。他のflowの承認や却下からの入口は、そのflowの図へのリンクにする。 */
function EntryItem({ entry }: { entry: FlowEntry }) {
  const text = safeText(entryText(entry));
  const to = entry.kind === "flow" ? flowDiagramPath(entry.flow) : null;
  return to === null ? (
    <>{text}</>
  ) : (
    <Link to={to} className={LIST_LINK_CLASS}>
      {text}
    </Link>
  );
}

/** flowの名前を「、」でつないで並べる。それぞれ図へのリンクにする。 */
function FlowNameLinks({ names }: { names: readonly string[] }) {
  return names.map((name, index) => (
    <span key={name}>
      {index === 0 ? "" : "、"}
      <FlowNameLink name={name} />
    </span>
  ));
}

/**
 * 図が読めない狭い幅の代わりの一覧。入口、ステップ、出口の順に並べる。
 * 他のflowのステップから起動される入口と差し戻しは、起動元のflowとして1行にまとめ、図へのリンクにする。
 * flow自身へ戻る出口は、同じ図なのでリンクにしない。出口には、つくステップを添える。
 */
function FlowDiagramList({ model }: { model: FlowDiagramModel }) {
  const { flow } = model;
  const grouped = groupEntriesForList(flow);
  const name = safeText(flow.name);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-small">
      <p className={SECTION_LABEL}>入口</p>
      <ul aria-label="入口" className="flex flex-col gap-1">
        {grouped.entries.map((entry) => (
          <li key={JSON.stringify(entry)}>
            <EntryItem entry={entry} />
          </li>
        ))}
        {grouped.launchFlows.length === 0 ? null : (
          <li>
            他のflowのステップ: <FlowNameLinks names={grouped.launchFlows} />
          </li>
        )}
        {grouped.reworkFlows.length === 0 ? null : (
          <li>
            他のflowからの差し戻し:{" "}
            <FlowNameLinks names={grouped.reworkFlows} />
          </li>
        )}
      </ul>
      <p className={SECTION_LABEL}>ステップ</p>
      <ol
        aria-label={`${name}のステップ`}
        className="divide-y divide-border rounded-lg border border-border"
      >
        {model.steps.map((node) => (
          <li key={node.step.id} className="flex flex-col gap-1 px-3 py-2">
            <span className="font-medium break-words">
              {safeText(node.step.summary)}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-caption break-all text-muted-foreground">
                {safeText(node.step.id)}
              </span>
              {model.overlay && node.step.conditional ? (
                <span className="text-caption text-muted-foreground">
                  {CONDITIONAL_WORD}
                </span>
              ) : null}
              {node.data === null ? null : (
                <StepStateBadge
                  state={node.data.state}
                  skipped={node.data.skipped}
                />
              )}
              <JobLink jobId={node.jobId} label="ログと結果を見る" />
            </span>
          </li>
        ))}
      </ol>
      {flow.exits.length === 0 ? null : (
        <>
          <p className={SECTION_LABEL}>出口</p>
          <ul aria-label="出口" className="flex flex-col gap-1">
            {flow.exits.map((exit) => {
              const to = flowDiagramPath(exit.flow);
              const text = safeText(exitText(exit));
              return (
                <li key={exitKey(exit)}>
                  <span className="text-muted-foreground">
                    {safeText(exitOriginText(exit))}
                  </span>{" "}
                  {to === null || isSelfExit(flow, exit) ? (
                    text
                  ) : (
                    <Link to={to} className={LIST_LINK_CLASS}>
                      {text}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * 図の下に添える注記。
 * 設定や試行の上限で起動が決まる辺を持つflowには、起動しない場合があると1文で伝える。
 * 本番ではまだ起動しない入口があるflowには、そのことを伝える。
 */
function Notes({ model }: { model: FlowDiagramModel }) {
  const { flow } = model;
  const conditional = hasConditionalEdges(flow);
  if (!conditional && flow.unwiredEntries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-small text-muted-foreground">
      {conditional ? <p>{CONDITIONAL_EDGES_NOTE}</p> : null}
      {flow.unwiredEntries.map((entry) => (
        <p key={JSON.stringify(entry)}>{safeText(unwiredText(entry))}</p>
      ))}
    </div>
  );
}

/** 定義に無いステップ。定義を直した後に古いジョブを開いたとき、止まったステップを隠さないために出す。 */
function UnknownSteps({ model }: { model: FlowDiagramModel }) {
  if (model.unknownSteps.length === 0) return null;
  return (
    <section aria-label={UNKNOWN_STEPS_HEADING} className="flex flex-col gap-2">
      <p className="text-small font-semibold">{UNKNOWN_STEPS_HEADING}</p>
      <p className="text-small text-muted-foreground">
        flowの定義にidが無いステップです。定義を変えた後に、古いジョブを開いたときに出ます。
      </p>
      <StepList steps={model.unknownSteps} back={undefined} />
    </section>
  );
}

/**
 * 図を、節の幅に合わせた見せ方で包む。
 * 収まるときはカードに入れて図をそのまま、収まらないときは横にスクロールできる枠に入れる。
 * 枠は、キーボードで焦点を当てないと隠れた部分を読めないので、焦点を受けられるようにする。
 * 幅が狭く図が読めないときは、図の代わりに、入口、ステップ、出口の一覧を出す。
 * 定義に無いステップは、どの見せ方でも図の後ろに出す。
 */
export function FlowDiagramFrame({
  model,
  presentation,
}: {
  model: FlowDiagramModel;
  presentation: GraphPresentation;
}) {
  const layout = useMemo(() => layoutFlowDiagram(model), [model]);
  const label = safeText(diagramLabel(model.flow.name));
  const body =
    presentation === "list" ? (
      <FlowDiagramList model={model} />
    ) : presentation === "fit" ? (
      <div className="rounded-xl border border-border bg-card p-2">
        <FlowDiagram layout={layout} label={label} overlay={model.overlay} />
      </div>
    ) : (
      // 横にスクロールできる領域は、キーボードで焦点を当てないと読み進められない。
      // biome-ignore lint/a11y/useSemanticElements: 領域の役割を明示する。sectionは、見出しを持つ節と取り違えられる。
      <div
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上。
        tabIndex={0}
        aria-label={`${label}(横にスクロールできます)`}
        className="overflow-x-auto rounded-xl border border-border bg-card p-2 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FlowDiagram layout={layout} label={label} overlay={model.overlay} />
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {body}
      <Notes model={model} />
      <UnknownSteps model={model} />
    </div>
  );
}
