import { useMemo } from "react";
import { JobLink } from "../../../components/JobLink.tsx";
import {
  flowDiagramModel,
  layoutFlowDiagram,
} from "../../../lib/flowDiagram.ts";
import { graphPresentation } from "../../../lib/flowGraphFit.ts";
import {
  FLOWS_DATA,
  type FlowDefinition,
  type FlowsData,
  findFlow,
} from "../../../lib/flowsData.ts";
import { isActiveJobState, jobScriptName } from "../../../lib/jobsView.ts";
import { safeText } from "../../../lib/safeText.ts";
import { useElementWidth } from "../../../lib/useElementWidth.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";
import { FlowDiagramFrame } from "../../jobs/FlowDiagram.tsx";
import { StepList } from "../../jobs/JobDetailParts.tsx";
import { JobStateBadge } from "../../jobs/JobRows.tsx";
import { EmptyNote, Panel } from "./DetailParts.tsx";

/** 最新の取得に失敗して、前の値を出していることの印。 */
const STALE_MARK = "前の値(取得に失敗)";

type StepsView = Extract<FlowProgressView, { kind: "steps" }>;

type WidthRef = (element: HTMLElement | null) => (() => void) | undefined;

/**
 * 現在のflowの図。ステップの状態を重ね、実行中のステップを強調する。
 * 幅は、図を包む要素の実際の幅から決める。測る前は描かない。描き直しで見せ方が変わると画面がちらつくためである。
 */
function FlowBlock({
  flow,
  view,
  width,
  widthRef,
}: {
  flow: FlowDefinition;
  view: StepsView;
  width: number;
  widthRef: WidthRef | undefined;
}) {
  const model = useMemo(
    () => flowDiagramModel(flow, view.steps),
    [flow, view.steps],
  );
  const extent = useMemo(() => layoutFlowDiagram(model).width, [model]);
  return (
    <div ref={widthRef}>
      {width <= 0 ? null : (
        <FlowDiagramFrame
          model={model}
          presentation={graphPresentation(width, extent)}
        />
      )}
    </div>
  );
}

/**
 * 現在のflow。見出しにflow名、実行中と待ち以外のジョブの状態、ジョブの詳細へのリンク、前の値の印を置き、その下に図を置く。
 * 図が実行中か待ちを示しているときは、状態の語を見出しに重ねない。
 * 同梱のデータにflowが無いときは、図を描けないので、ステップの一覧に替える。
 */
function Current({
  view,
  flow,
  width,
  widthRef,
}: {
  view: StepsView;
  flow: FlowDefinition | null;
  width: number;
  widthRef: WidthRef | undefined;
}) {
  const name = safeText(jobScriptName(view.flowPath));
  const showsState = !(flow !== null && isActiveJobState(view.jobState));
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
      {flow !== null ? (
        <FlowBlock flow={flow} view={view} width={width} widthRef={widthRef} />
      ) : view.steps.length === 0 ? (
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
 * 動いているflowの進行。ジョブが実行中、待ち、失敗、取消のときに、そのflowの図へステップの状態を重ねる。
 * 図のノードは、子のジョブの詳細と次のflowの図へ移る。動いていないflowの履歴は他の作業項目も含むので、リンクにしない。
 * 進行を読めず、前の値も無いときは、読めなかったと伝える。
 * 進めているflowが無いとき、成功かスキップで終わったジョブのときは、何も描かない。承認の判断は受信箱で行う。
 * 図の幅は、図を包む要素の実際の幅から決める。狭いときは、入口、ステップ、出口の一覧にする。
 */
export function ItemFlowProgressView({
  view,
  data,
  width,
  widthRef,
}: {
  view: FlowProgressView;
  /** 同梱のflowごとの図のデータ。読めなかったときは`null`。 */
  data: FlowsData | null;
  /** 図を包む要素の実際の幅(px)。 */
  width: number;
  /** 幅を測る要素の`ref`。 */
  widthRef?: WidthRef;
}) {
  if (view.kind === "none") return null;
  return (
    <Panel heading="進行">
      {view.kind === "unreadable" ? (
        <EmptyNote>進行を読めませんでした。</EmptyNote>
      ) : (
        <Current
          view={view}
          flow={findFlow(data, jobScriptName(view.flowPath))}
          width={width}
          widthRef={widthRef}
        />
      )}
    </Panel>
  );
}

/** 作業項目の進行の区画。図を包む要素の幅を測って、表示の部分に渡す。 */
export function ItemFlowProgress(props: { view: FlowProgressView }) {
  const { ref, width } = useElementWidth();
  return (
    <ItemFlowProgressView
      {...props}
      data={FLOWS_DATA}
      width={width}
      widthRef={ref}
    />
  );
}
