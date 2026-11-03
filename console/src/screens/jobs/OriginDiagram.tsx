import { Check, TriangleAlert, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useMemo,
  useRef,
} from "react";
import { Link } from "react-router";
import { Disclosure } from "../../components/Disclosure.tsx";
import { EmptyNote } from "../../components/EmptyNote.tsx";
import { Card, cardVariants } from "../../components/ui/card.tsx";
import { cn } from "../../lib/cn.ts";
import { CONDITIONAL_EDGES_NOTE, exitWord } from "../../lib/flowDiagram.ts";
import { graphPresentation, wrapLines } from "../../lib/flowGraphFit.ts";
import { flowDiagramPath } from "../../lib/flowsData.ts";
import {
  footNotes,
  layoutOriginGraph,
  NOTE_EM,
  type OriginEdgeLayout,
  type OriginFlowNode,
  type OriginGraphModel,
  type OriginLayout,
  type OriginNodeLayout,
  type OriginRunView,
  originDiagramLabel,
} from "../../lib/originGraph.ts";
import { safeText } from "../../lib/safeText.ts";

/** flowを起動しない定期ジョブに出す文。 */
const EMPTY_TEXT = "この定期ジョブはflowを起動しません。";

/** 図の下に1行で添える、線と注記の読み方。 */
const LEGEND_TEXT =
  "実線は起動の流れです。「承認」の線は承認の後の起動で、戻りは各flowの下に注記します。";

/** PRを介した線を持つ図の凡例。破線の意味は、この図の中で決める。 */
const LEGEND_WITH_PR_TEXT =
  "実線は起動の流れ、破線はPRを介した関係(この起点を含む定期ジョブがPRのラベルやCIの結果を見て起動するもので、人のラベルを含む)です。「承認」の線は承認の後の起動で、戻りは各flowの下に注記します。";

/** PRを介した線の破線の模様。 */
const PR_DASH = "6 4";

/** 箱の左右の余白(px)。 */
const PAD_X = 10;
/** 箱に収める文字数(em)。名前は12px、そのほかは11pxで描く。 */
const NAME_EM = 13;
const DESCRIPTION_EM = 16;
const STEP_TEXT_EM = 14;
const ORIGIN_TEXT_EM = 14;

const LINK_CLASS =
  "outline-none [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3px]";

/** 見出しのボタン。輪は見出しの矩形にだけ付ける。 */
const HEADING_CLASS =
  "cursor-pointer outline-none [&:hover>rect]:fill-accent [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3px]";

type Tone = "success" | "failure" | "warning" | "neutral";

type RunLine = { readonly tone: Tone; readonly text: string };

/** 起点の箱の実行の欄に書く行。成否は記号と文言で、止まっているときの印はその下に添える。 */
function runLines(run: OriginRunView): RunLine[] {
  switch (run.kind) {
    case "loading":
      return [{ tone: "neutral", text: "読み込み中…" }];
    case "login":
      return [{ tone: "warning", text: "ログインが必要です" }];
    case "failed":
      return [{ tone: "failure", text: "取得できませんでした" }];
    case "missing":
      return [{ tone: "warning", text: "Windmillにありません" }];
    case "ready": {
      const last: RunLine =
        run.lastRun === "success"
          ? { tone: "success", text: "直近の実行: 成功" }
          : run.lastRun === "failure"
            ? { tone: "failure", text: "直近の実行: 失敗・取消" }
            : { tone: "neutral", text: "実行の記録がありません" };
      return [
        last,
        ...run.marks.map((mark): RunLine => ({ tone: "warning", text: mark })),
      ];
    }
  }
}

/** 行を並べるときの、重ならない目印。 */
function lineKey(line: RunLine): string {
  return [line.tone, line.text].join(" ");
}

const TONE_FILL: Readonly<Record<Tone, string>> = {
  success: "fill-success",
  failure: "fill-failure",
  warning: "fill-warning",
  neutral: "fill-muted-foreground",
};

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  success: "text-success",
  failure: "text-failure",
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

/** 成否と印の記号。色だけに頼らず、形でも見分けられるようにする。 */
function ToneMark({ tone, x, y }: { tone: Tone; x: number; y: number }) {
  if (tone === "neutral") return null;
  const d =
    tone === "success"
      ? `M${x},${y - 4} L${x + 3},${y - 1} L${x + 8},${y - 8}`
      : tone === "failure"
        ? `M${x},${y - 8} L${x + 8},${y} M${x + 8},${y - 8} L${x},${y}`
        : `M${x + 4},${y - 9} L${x + 9},${y} L${x - 1},${y} Z`;
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 図形は焦点を受けない。装飾の記号を読み上げから外す。
    <path
      aria-hidden="true"
      d={d}
      className={cn(
        "fill-none",
        tone === "success"
          ? "stroke-success"
          : tone === "failure"
            ? "stroke-failure"
            : "stroke-warning",
      )}
      strokeWidth={1.8}
    />
  );
}

const MARK_WIDTH = 14;

function OriginBox({
  layout,
  model,
  run,
}: {
  layout: OriginLayout;
  model: OriginGraphModel;
  run: OriginRunView;
}) {
  const box = layout.origin;
  const x = box.x + PAD_X;
  const name = wrapLines(safeText(model.origin.name), ORIGIN_TEXT_EM, 1).join(
    "",
  );
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={10}
        strokeWidth={1}
        className="fill-accent stroke-edge"
      />
      <text x={x} y={box.y + 18} className="fill-muted-foreground text-[11px]">
        スケジュール
      </text>
      <text
        x={x}
        y={box.y + 36}
        className="fill-foreground font-mono text-[11px] font-semibold"
      >
        {name}
      </text>
      <line
        x1={box.x}
        y1={box.y + 48}
        x2={box.x + box.width}
        y2={box.y + 48}
        className="stroke-edge"
        strokeWidth={1}
      />
      {runLines(run).map((line, index) => {
        const y = box.y + 66 + index * 18;
        return (
          <g key={lineKey(line)}>
            <ToneMark tone={line.tone} x={x} y={y} />
            <text
              x={x + (line.tone === "neutral" ? 0 : MARK_WIDTH)}
              y={y}
              className={cn(
                "text-[11px]",
                TONE_FILL[line.tone],
                line.tone === "neutral" ? "" : "font-semibold",
              )}
            >
              {wrapLines(
                safeText(line.text),
                ORIGIN_TEXT_EM - (line.tone === "neutral" ? 0 : 1.2),
                1,
              ).join("")}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * flowの見出し。押すか、キーボードで開閉する。
 * Enterはkeydownで、Spaceはkeyupで切り替える(ネイティブのボタンと同じ)。
 * Spaceの押し始めがこの要素のときだけ切り替える。ほかの要素で押し始め、押している間に焦点が移ったときに、切り替えないためである。
 * 子には矩形と、名前の文字と、開閉の印だけを置く。説明、ステップ数、リンク、注記は、ボタンの外の兄弟として描く。
 * ボタンの子は読み上げの対象にならず、リンクを入れると入れ子の操作になるためである。
 * 見える文字がボタンの名前(`aria-label`)に含まれないと、名前と見える文字が食い違うので、見える文字は名前だけにする。
 */
function HeadingButton({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const pressed = useRef(false);
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onToggle(!open);
    } else if (event.key === " ") {
      event.preventDefault();
      if (!event.repeat) pressed.current = true;
    }
  };
  const handleKeyUp = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== " ") return;
    event.preventDefault();
    if (!pressed.current) return;
    pressed.current = false;
    onToggle(!open);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVGの図形はbuttonにできない。役割と、キーボードの操作を明示する。
    <g
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={label}
      className={HEADING_CLASS}
      onClick={() => {
        onToggle(!open);
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={() => {
        pressed.current = false;
      }}
    >
      {children}
    </g>
  );
}

/** 開閉の印。閉じていれば右向き、開いていれば下向きの三角にする。 */
function Chevron({ x, y, open }: { x: number; y: number; open: boolean }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 図形は焦点を受けない。装飾の記号を読み上げから外す。
    <polygon
      aria-hidden="true"
      points={
        open
          ? `${x},${y} ${x + 10},${y} ${x + 5},${y + 7}`
          : `${x},${y - 1} ${x + 7},${y + 4} ${x},${y + 9}`
      }
      className="fill-muted-foreground"
    />
  );
}

function FlowNodeView({
  layout,
  node,
  stepMarkerId,
  onToggle,
}: {
  layout: OriginNodeLayout;
  node: OriginFlowNode;
  stepMarkerId: string;
  onToggle: (flow: string, open: boolean) => void;
}) {
  const x = layout.x + PAD_X;
  const flowName = node.flow.name;
  const name = wrapLines(safeText(flowName), NAME_EM, 1).join("");
  const description = wrapLines(
    safeText(node.flow.summary),
    DESCRIPTION_EM,
    1,
  ).join("");
  const stepCount = `${node.flow.steps.length}ステップ`;
  const to = flowDiagramPath(flowName);
  const linkName = `flowの図: ${safeText(flowName)}`;
  const headingName = `${safeText(flowName)}のステップ`;
  const notes = footNotes(node);
  const firstNote = layout.notes[0];
  return (
    <g>
      <rect
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        rx={10}
        strokeWidth={1}
        className="fill-card stroke-edge"
      />
      <HeadingButton
        label={headingName}
        open={layout.expanded}
        onToggle={(open) => {
          onToggle(flowName, open);
        }}
      >
        <rect
          x={layout.x}
          y={layout.y}
          width={layout.width}
          height={layout.headerHeight}
          rx={10}
          strokeWidth={1}
          className="fill-transparent stroke-transparent"
        />
        <text
          x={x}
          y={layout.y + 20}
          className="fill-foreground text-caption font-semibold"
        >
          {name}
        </text>
        <Chevron
          x={layout.x + layout.width - PAD_X - 10}
          y={layout.y + 12}
          open={layout.expanded}
        />
      </HeadingButton>
      <text
        x={x}
        y={layout.y + 37}
        className="pointer-events-none fill-muted-foreground text-[11px]"
      >
        {description}
      </text>
      <text
        x={x}
        y={layout.y + 54}
        className="pointer-events-none fill-muted-foreground text-[11px]"
      >
        {stepCount}
      </text>
      {layout.steps.map((row, index) => {
        const step = node.flow.steps[index];
        if (step === undefined) return null;
        const next = layout.steps[index + 1];
        const center = layout.x + layout.width / 2;
        return (
          <g key={step.id}>
            <rect
              x={x}
              y={row.y}
              width={layout.width - PAD_X * 2}
              height={row.height}
              rx={6}
              strokeWidth={1}
              className="fill-accent stroke-edge"
            />
            <text
              x={x + 8}
              y={row.y + 16}
              className="fill-foreground font-mono text-[11px]"
            >
              {wrapLines(safeText(step.id), STEP_TEXT_EM, 1).join("")}
            </text>
            <text
              x={x + 8}
              y={row.y + 31}
              className="fill-muted-foreground text-[11px]"
            >
              {wrapLines(safeText(step.summary), STEP_TEXT_EM, 1).join("")}
            </text>
            {next === undefined ? null : (
              <line
                x1={center}
                y1={row.y + row.height}
                x2={center}
                y2={next.y}
                className="stroke-muted-foreground"
                strokeWidth={1}
                markerEnd={`url(#${stepMarkerId})`}
              />
            )}
          </g>
        );
      })}
      {layout.linkY === null || to === null ? null : (
        <Link to={to} aria-label={linkName} className={LINK_CLASS}>
          <rect
            x={x}
            y={layout.linkY}
            width={layout.width - PAD_X * 2}
            height={24}
            rx={6}
            strokeWidth={1}
            className="fill-transparent stroke-transparent"
          />
          <text
            x={x + 8}
            y={layout.linkY + 16}
            className="fill-primary text-[11px] underline"
          >
            flowの図
          </text>
        </Link>
      )}
      {firstNote === undefined ? null : (
        <line
          x1={layout.x + PAD_X}
          y1={firstNote.y - 4}
          x2={layout.x + layout.width - PAD_X}
          y2={firstNote.y - 4}
          className="stroke-edge"
          strokeWidth={1}
        />
      )}
      {notes.map((exit, index) => {
        const row = layout.notes[index];
        return row === undefined ? null : (
          <text
            key={`${exit.via} ${exit.to}`}
            x={x}
            y={row.y + 13}
            className="fill-muted-foreground text-[11px]"
          >
            {wrapLines(safeText(row.text), NOTE_EM, 1).join("")}
          </text>
        );
      })}
    </g>
  );
}

function EdgeView({
  item,
  markerId,
}: {
  item: OriginEdgeLayout;
  markerId: string;
}) {
  return (
    <>
      <polyline
        points={item.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeLinejoin="round"
        markerEnd={`url(#${markerId})`}
        {...(item.edge.via === "pr" ? { strokeDasharray: PR_DASH } : {})}
      />
      {item.label === null || item.word === null ? null : (
        <text
          x={item.label.x}
          y={item.label.y}
          textAnchor="middle"
          className="fill-foreground stroke-card text-[11px] font-semibold [paint-order:stroke]"
          strokeWidth={4}
        >
          {safeText(item.word)}
        </text>
      )}
    </>
  );
}

/**
 * 起動の図。配置は`layoutOriginGraph`が決め、箱と線を自前のSVGで描く。
 * 色はすべてCSSのトークンで指定するので、ライトとダークの両方で読める。
 * 見出しはボタン、「flowの図」はリンクで、どちらもキーボードで届く。Tabの順は、段の順、上から下の順である。
 */
function OriginSvg({
  layout,
  model,
  run,
  onToggle,
}: {
  layout: OriginLayout;
  model: OriginGraphModel;
  run: OriginRunView;
  onToggle: (flow: string, open: boolean) => void;
}) {
  const markerId = `origin-arrow-${useId().replace(/:/g, "")}`;
  const label = safeText(originDiagramLabel(model.origin.name));
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVGの中にfieldsetは置けない。リンクとボタンを含む図なので、imgにもできない。
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
        <marker
          id={`${markerId}-step`}
          viewBox="0 0 10 10"
          refX={10}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {layout.edges.map((item) => (
        <EdgeView
          key={`${item.edge.from ?? "origin"}>${item.edge.to} ${item.edge.via}`}
          item={item}
          markerId={markerId}
        />
      ))}
      <OriginBox layout={layout} model={model} run={run} />
      {layout.nodes.map((nodeLayout) => {
        const node = model.nodes.find(
          (candidate) => candidate.flow.name === nodeLayout.flow,
        );
        return node === undefined ? null : (
          <FlowNodeView
            key={nodeLayout.flow}
            layout={nodeLayout}
            node={node}
            stepMarkerId={`${markerId}-step`}
            onToggle={onToggle}
          />
        );
      })}
    </svg>
  );
}

/**
 * 横にスクロールできる枠。キーボードで焦点を当てないと読み進められないので、焦点を受けられるようにする。
 */
function ScrollFrame({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 領域の役割を明示する。sectionは、見出しを持つ節と取り違えられる。
    <div
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上。
      tabIndex={0}
      aria-label={`${label}(横にスクロールできます)`}
      className={cn(
        cardVariants({ padding: "frame" }),
        "overflow-x-auto focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </div>
  );
}

const SECTION_LABEL = "text-caption font-semibold text-muted-foreground";

const LIST_LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RunRows({ run }: { run: OriginRunView }) {
  return (
    <>
      {runLines(run).map((line) => (
        <p
          key={lineKey(line)}
          className={cn(
            "flex items-center gap-1.5",
            TONE_TEXT[line.tone],
            line.tone === "neutral" ? "" : "font-medium",
          )}
        >
          {line.tone === "success" ? (
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
          ) : line.tone === "failure" ? (
            <X aria-hidden="true" className="size-3.5 shrink-0" />
          ) : line.tone === "warning" ? (
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
          {safeText(line.text)}
        </p>
      ))}
    </>
  );
}

function ListFlow({
  node,
  open,
  onToggle,
}: {
  node: OriginFlowNode;
  open: boolean;
  onToggle: (flow: string, open: boolean) => void;
}) {
  const flowName = node.flow.name;
  const to = flowDiagramPath(flowName);
  return (
    <Card
      tag="div"
      padding="compact"
      className="flex flex-col gap-2 text-small"
    >
      <Disclosure
        initiallyOpen={open}
        onToggle={(next) => {
          onToggle(flowName, next);
        }}
        summary={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-medium break-all">{safeText(flowName)}</span>
            <span className="text-caption text-muted-foreground">
              {node.flow.steps.length}ステップ
            </span>
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">{safeText(node.flow.summary)}</p>
          <ol
            aria-label={`${safeText(flowName)}のステップ`}
            className="divide-y divide-border rounded-lg border border-border"
          >
            {node.flow.steps.map((step) => (
              <li key={step.id} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="font-mono text-caption break-all">
                  {safeText(step.id)}
                </span>
                <span className="break-words text-muted-foreground">
                  {safeText(step.summary)}
                </span>
              </li>
            ))}
          </ol>
          {to === null ? null : (
            <p>
              <Link
                to={to}
                aria-label={`flowの図: ${safeText(flowName)}`}
                className={LIST_LINK_CLASS}
              >
                flowの図
              </Link>
            </p>
          )}
        </div>
      </Disclosure>
      {node.exits.length === 0 ? null : (
        <ul
          aria-label={`${safeText(flowName)}の出口`}
          className="flex flex-col gap-0.5 text-muted-foreground"
        >
          {node.exits.map((exit) => (
            <li key={`${exit.via} ${exit.to}`}>{safeText(exit.text)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 図が読めない狭い幅の代わりの一覧。起点の箱、段ごとのflowの順に並べる。
 * 開閉は、図と共有する集合の値で決め、開閉の変化を呼び出し側へ返す。幅が変わって図と一覧が入れ替わっても、開閉が保たれる。
 * 出口の行は、図の線と注記の代わりに、起点のカードと各flowの下に並べる。
 */
function OriginList({
  model,
  run,
  expanded,
  onToggle,
}: {
  model: OriginGraphModel;
  run: OriginRunView;
  expanded: ReadonlySet<string>;
  onToggle: (flow: string, open: boolean) => void;
}) {
  const columns = Array.from(
    { length: Math.max(0, model.columns - 1) },
    (_, index) => index + 1,
  );
  // 段を飛ぶ起動も含め、起点からの線をすべて並べる。1段目のflowの並びだけでは、段を飛ぶ起動が落ちる。
  const launched = model.edges
    .filter((edge) => edge.from === null)
    .map((edge) => edge.to);
  return (
    <div className="flex flex-col gap-3">
      <Card padding="compact" className="flex flex-col gap-1 text-small">
        <p className={SECTION_LABEL}>スケジュール</p>
        <p className="font-mono font-medium break-all">
          {safeText(model.origin.name)}
        </p>
        <RunRows run={run} />
        {launched.length === 0 ? null : (
          <ul
            aria-label={`${safeText(model.origin.name)}の出口`}
            className="flex flex-col gap-0.5 text-muted-foreground"
          >
            {launched.map((flow) => (
              <li key={flow}>{safeText(`${exitWord("launch")}: ${flow}`)}</li>
            ))}
          </ul>
        )}
      </Card>
      {columns.map((column) => (
        <section
          key={column}
          aria-label={`${column}段目`}
          className="flex flex-col gap-2"
        >
          <p className={SECTION_LABEL}>{column}段目</p>
          {model.nodes
            .filter((node) => node.column === column)
            .map((node) => (
              <ListFlow
                key={node.flow.name}
                node={node}
                open={expanded.has(node.flow.name)}
                onToggle={onToggle}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

/**
 * 起動の図の本体。状態を持たず、幅と開いているflowを引数で受け、開閉の変化を`onToggle`で返す。
 * 幅に合わせて、収まるときは図をそのまま、収まらず640px以上なら横にスクロールする枠に入れた図、640px未満は段ごとの一覧にする。
 * 図の幅は開閉で変わらないので、開閉で見せ方は入れ替わらない。
 * flowを起動しない定期ジョブは、図の代わりにそのことを書く。
 */
export function OriginDiagramView({
  model,
  run,
  width,
  expanded,
  onToggle,
}: {
  model: OriginGraphModel;
  run: OriginRunView;
  width: number;
  expanded: ReadonlySet<string>;
  onToggle: (flow: string, open: boolean) => void;
}) {
  const layout = useMemo(
    () => layoutOriginGraph(model, expanded),
    [model, expanded],
  );
  if (model.nodes.length === 0) {
    return <EmptyNote>{EMPTY_TEXT}</EmptyNote>;
  }
  const presentation = graphPresentation(width, layout.width);
  const svg = (
    <OriginSvg layout={layout} model={model} run={run} onToggle={onToggle} />
  );
  const label = safeText(originDiagramLabel(model.origin.name));
  return (
    <div className="flex flex-col gap-3">
      {presentation === "list" ? (
        <OriginList
          model={model}
          run={run}
          expanded={expanded}
          onToggle={onToggle}
        />
      ) : presentation === "fit" ? (
        <Card padding="frame">{svg}</Card>
      ) : (
        <ScrollFrame label={label}>{svg}</ScrollFrame>
      )}
      {presentation === "list" ? null : (
        <p className="text-small text-muted-foreground">
          {model.edges.some((edge) => edge.via === "pr")
            ? LEGEND_WITH_PR_TEXT
            : LEGEND_TEXT}
        </p>
      )}
      {model.conditional ? (
        <p className="text-small text-muted-foreground">
          {CONDITIONAL_EDGES_NOTE}
        </p>
      ) : null}
    </div>
  );
}
