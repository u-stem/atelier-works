import { FileQuestion } from "lucide-react";
import { useMemo } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { PageHeader } from "../../app/PageHeader.tsx";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import { flowDiagramCrumbs } from "../../lib/breadcrumbs.ts";
import { flowDiagramModel, layoutFlowDiagram } from "../../lib/flowDiagram.ts";
import { graphPresentation } from "../../lib/flowGraphFit.ts";
import {
  FLOWS_DATA,
  type FlowDefinition,
  type FlowsData,
  flowHistoryPath,
  flowRouteState,
} from "../../lib/flowsData.ts";
import { JOBS_PATH, parseJobsBack } from "../../lib/jobsView.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import { safeText } from "../../lib/safeText.ts";
import { useElementWidth } from "../../lib/useElementWidth.ts";
import { FlowDiagramFrame } from "./FlowDiagram.tsx";

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SCREEN_TITLE = "flowの図";

/** 見つからないときと、読めないときの本文。名前は、安全でない値を含みうるので書かない。 */
function Notice({ back, text }: { back: string | null; text: string }) {
  return (
    <>
      <PageHeader title={SCREEN_TITLE}>
        <Breadcrumb
          items={[
            { label: "ジョブ", to: back ?? JOBS_PATH },
            { label: SCREEN_TITLE },
          ]}
        />
      </PageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
          <FileQuestion aria-hidden="true" className="size-6" />
        </span>
        <p className="max-w-sm text-small text-muted-foreground">{text}</p>
      </div>
    </>
  );
}

function FlowBody({
  flow,
  back,
  width,
  widthRef,
}: {
  flow: FlowDefinition;
  back: string | null;
  width: number;
  widthRef?:
    | ((element: HTMLElement | null) => (() => void) | undefined)
    | undefined;
}) {
  const model = useMemo(() => flowDiagramModel(flow, null), [flow]);
  const extent = useMemo(() => layoutFlowDiagram(model).width, [model]);
  return (
    <>
      <PageHeader title={safeText(flow.name)} subtitle={safeText(flow.summary)}>
        <Breadcrumb items={flowDiagramCrumbs(safeText(flow.name), back)} />
      </PageHeader>
      <div className={SCROLL_BODY_CLASS}>
        <section className="flex max-w-4xl flex-col gap-3">
          {flow.description === "" ? null : (
            <p className="text-small text-muted-foreground">
              {safeText(flow.description)}
            </p>
          )}
          <p className="text-small">
            <Link to={flowHistoryPath(flow.name)} className={LINK_CLASS}>
              このflowのジョブの履歴
            </Link>
          </p>
        </section>
        <div ref={widthRef} className="max-w-6xl">
          <FlowDiagramFrame
            model={model}
            presentation={graphPresentation(width, extent)}
          />
        </div>
      </div>
    </>
  );
}

/**
 * flowの図の画面の表示の部分。経路の名前と、データと、図を包む要素の実際の幅から描く。
 * 名前は一覧から探し、データに無い名前と安全でない名前は「見つかりません」とだけ書く。
 * 図は静的で、実行の状態は重ねない。実行の状態は、作業項目の詳細の進行が示す。
 * 幅が狭いときは、図の代わりに入口、ステップ、出口の一覧を出す。
 */
export function FlowScreenView({
  name,
  data,
  back,
  width,
  widthRef,
}: {
  name: string;
  data: FlowsData | null;
  back: string | null;
  width: number;
  widthRef?: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  const state = flowRouteState(name, data);
  if (state.kind === "found") {
    return (
      <FlowBody
        flow={state.flow}
        back={back}
        width={width}
        widthRef={widthRef}
      />
    );
  }
  return (
    <Notice
      back={back}
      text={
        state.kind === "unreadable"
          ? "flowの図のデータを読み込めませんでした。"
          : "flowが見つかりません。"
      }
    />
  );
}

/** flowの図の画面。経路の`:name`を読み、名前が無ければジョブの一覧へ戻す。 */
export function FlowScreen() {
  const params = useParams();
  const back = parseJobsBack(useLocation().state);
  const { ref, width } = useElementWidth();
  if (flowRouteState(params.name, FLOWS_DATA).kind === "redirect") {
    return <Navigate to={JOBS_PATH} replace />;
  }
  return (
    <FlowScreenView
      name={params.name ?? ""}
      data={FLOWS_DATA}
      back={back}
      width={width}
      widthRef={ref}
    />
  );
}
