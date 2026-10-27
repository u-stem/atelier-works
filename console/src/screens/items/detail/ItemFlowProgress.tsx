import { useMemo } from "react";
import { JobLink } from "../../../components/JobLink.tsx";
import type { FlowGraph } from "../../../lib/flowGraph.ts";
import { FLOW_GRAPH } from "../../../lib/flowGraphData.ts";
import { graphPresentation } from "../../../lib/flowGraphFit.ts";
import { layoutExtent, layoutFlowGraph } from "../../../lib/flowGraphLayout.ts";
import { itemFlowGraph } from "../../../lib/itemFlowGraph.ts";
import { isActiveJobState, jobScriptName } from "../../../lib/jobsView.ts";
import { safeText } from "../../../lib/safeText.ts";
import { useElementWidth } from "../../../lib/useElementWidth.ts";
import {
  type FlowProgressView,
  flowGraphStateOfProgress,
} from "../../../lib/workItemFlowProgress.ts";
import { FlowGraphFrame } from "../../jobs/FlowGraphDiagram.tsx";
import { StepList } from "../../jobs/JobDetailParts.tsx";
import { JobStateBadge } from "../../jobs/JobRows.tsx";
import { EmptyNote, Panel } from "./DetailParts.tsx";

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

/** 図の読み上げの名前。 */
const PATH_LABEL = "作業項目の経路の図";

/** 最新の取得に失敗して、前の値を出していることの印。 */
const STALE_MARK = "前の値(取得に失敗)";

type StepsView = Extract<FlowProgressView, { kind: "steps" }>;

/**
 * 現在のflowのステップ。flow名、ステップを定義の順に並べ、見出しからこのジョブの詳細へ移れる。
 * 図が実行中か待ちを示しているときは、状態の語を見出しに重ねない。図が出ないとき、止まったジョブを示すときは、見出しに状態を出す。
 * ステップの状態の語は、ジョブ詳細のステップの一覧と同じ関数で決める。
 */
function Steps({ view, hasDiagram }: { view: StepsView; hasDiagram: boolean }) {
  const name = safeText(jobScriptName(view.flowPath));
  const showsState = !(hasDiagram && isActiveJobState(view.jobState));
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-body font-semibold break-all">
          {`${name}のステップ`}
        </h3>
        {showsState ? <JobStateBadge state={view.jobState} /> : null}
        <JobLink jobId={view.jobId} label="ジョブを開く" />
        {view.stale ? (
          <span className="text-caption text-muted-foreground">
            {STALE_MARK}
          </span>
        ) : null}
      </div>
      {view.steps.length === 0 ? (
        <p className="text-small text-muted-foreground">
          ステップはまだありません。
        </p>
      ) : (
        <StepList steps={view.steps} back={undefined} />
      )}
    </section>
  );
}

/**
 * 作業項目の経路と、動いているflowの進行。
 * 経路は、作業項目の種別が通るflowと、それをつなぐscriptの図で、現在のflowを強調する。
 * 経路が1つのflowで完結する種別は、図を出さず、ステップだけを出す。箱が1つの図は、ステップの見出しと重なるためである。
 * その下に、現在のflowのステップを出す。進めているflowが無いとき、成功で終わったジョブのときは、経路だけを出す。
 * 進行を読めず、前の値も無いときは、読めなかったと伝える。
 * 出すものが無ければ、何も描かない。
 * 図の幅は、図を包む要素の実際の幅から決める。狭いときは、flowごとの一覧にする。
 * 図のノードは、実行中のジョブの詳細へだけ移る。動いていないflowの履歴は、他の作業項目も含むため、リンクにしない。
 */
export function ItemFlowProgressView({
  kind,
  graph,
  view,
  width,
  widthRef,
}: {
  kind: string;
  graph: FlowGraph | null;
  view: FlowProgressView;
  /** 図を包む要素の実際の幅(px)。 */
  width: number;
  /** 幅を測る要素の`ref`。 */
  widthRef?: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  const path = useMemo(
    () => (graph === null ? EMPTY_GRAPH : itemFlowGraph(kind, graph)),
    [kind, graph],
  );
  const extentWidth = useMemo(
    () => layoutExtent(layoutFlowGraph(path, { compact: true })).width,
    [path],
  );
  const hasDiagram = path.nodes.length >= 2;
  if (!hasDiagram && view.kind === "none") return null;
  const stale = view.kind === "steps" && view.stale;
  return (
    <Panel
      heading="進行"
      {...(hasDiagram
        ? {
            note: "作業項目が通るflowの経路です。強調は、いま動いているflowです。",
          }
        : {})}
    >
      {hasDiagram ? (
        <div ref={widthRef} className="flex flex-col gap-2">
          {stale ? (
            <p className="text-caption text-muted-foreground">{STALE_MARK}</p>
          ) : null}
          <FlowGraphFrame
            graph={path}
            state={flowGraphStateOfProgress(view)}
            presentation={graphPresentation(width, extentWidth)}
            label={PATH_LABEL}
            compact
            runningLinksOnly
          />
        </div>
      ) : null}
      {view.kind === "steps" ? (
        <Steps view={view} hasDiagram={hasDiagram} />
      ) : null}
      {view.kind === "unreadable" ? (
        <EmptyNote>進行を読めませんでした。</EmptyNote>
      ) : null}
    </Panel>
  );
}

/** 作業項目の進行の区画。図を包む要素の幅を測って、表示の部分に渡す。 */
export function ItemFlowProgress(props: {
  kind: string;
  view: FlowProgressView;
}) {
  const { ref, width } = useElementWidth();
  return (
    <ItemFlowProgressView
      {...props}
      graph={FLOW_GRAPH}
      width={width}
      widthRef={ref}
    />
  );
}
