import { useMemo } from "react";
import type { FlowGraph } from "../../../lib/flowGraph.ts";
import { FLOW_GRAPH } from "../../../lib/flowGraphData.ts";
import { graphPresentation } from "../../../lib/flowGraphFit.ts";
import { layoutExtent, layoutFlowGraph } from "../../../lib/flowGraphLayout.ts";
import { itemFlowGraph } from "../../../lib/itemFlowGraph.ts";
import { JOB_SCRIPT_PREFIX } from "../../../lib/jobsView.ts";
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

/**
 * 現在のflowのステップ。flow名、ジョブの状態、ステップを定義の順に並べる。
 * 取得に失敗して前の値を出しているときは、その旨を添える。
 * ステップの状態の語は、ジョブ詳細のステップの一覧と同じ関数で決める。
 */
function Steps({
  view,
}: {
  view: Extract<FlowProgressView, { kind: "steps" }>;
}) {
  const name = safeText(view.flowPath.replace(JOB_SCRIPT_PREFIX, ""));
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-body font-semibold break-all">
          {`${name}のステップ`}
        </h3>
        <JobStateBadge state={view.jobState} />
        {view.stale ? (
          <span className="text-caption text-muted-foreground">
            前の値(取得に失敗)
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
 * その下に、現在のflowのステップを出す。進めているflowが無いときは、経路だけを出す。
 * 進行を読めず、前の値も無いときは、読めなかったと伝える。
 * 出すものが無い種別で、進行も無ければ、何も描かない。
 * 図の幅は、図を包む要素の実際の幅から決める。狭いときは、flowごとの一覧にする。
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
  const hasPath = path.nodes.length > 0;
  if (!hasPath && view.kind === "none") return null;
  return (
    <Panel
      heading="進行"
      note="作業項目が通るflowの経路です。強調は、いま動いているflowです。"
    >
      {hasPath ? (
        <div ref={widthRef}>
          <FlowGraphFrame
            graph={path}
            state={flowGraphStateOfProgress(view)}
            presentation={graphPresentation(width, extentWidth)}
            label={PATH_LABEL}
            compact
          />
        </div>
      ) : null}
      {view.kind === "steps" ? <Steps view={view} /> : null}
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
