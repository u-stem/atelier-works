import { FileQuestion } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { useSchedules } from "../../api/jobsQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { useNow } from "../../app/useNow.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import { originDiagramCrumbs } from "../../lib/breadcrumbs.ts";
import {
  FLOWS_DATA,
  type FlowSchedule,
  type FlowsData,
  originRouteState,
} from "../../lib/flowsData.ts";
import { JOBS_PATH, parseJobsBack } from "../../lib/jobsView.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import {
  initialExpanded,
  originGraphModel,
  originRunView,
} from "../../lib/originGraph.ts";
import { safeText } from "../../lib/safeText.ts";
import { useElementWidth } from "../../lib/useElementWidth.ts";
import { OriginDiagramView } from "./OriginDiagram.tsx";

const SCREEN_TITLE = "起動の図";

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

/**
 * 見つかった定期ジョブの本体。開閉の状態と、起点の箱の実行の取得を持つ。
 * 開閉は、URLにも履歴にも残さない。起動するflowが1つだけの定期ジョブは、そのflowを初めから開く。
 * 取得は定期ジョブの一覧と同じクエリを読む。一覧と同じ60秒で古いとみなし、古ければ開いたときに1回だけ読む。
 * 自動では取り直さず、ジョブの終了を検知したときに、一覧と同じ取り直しで更新される。
 * 見つからない、読めないときの本体は、この部品を描かないので、取得も始まらない。
 */
function OriginBody({
  schedule,
  data,
  back,
  width,
  widthRef,
}: {
  schedule: FlowSchedule;
  data: FlowsData;
  back: string | null;
  width: number;
  widthRef?:
    | ((element: HTMLElement | null) => (() => void) | undefined)
    | undefined;
}) {
  const model = useMemo(
    () => originGraphModel(data, schedule.name),
    [data, schedule.name],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    model === null ? new Set() : initialExpanded(model),
  );
  const toggle = useCallback((flow: string, open: boolean) => {
    setExpanded((previous) => {
      if (previous.has(flow) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(flow);
      else next.delete(flow);
      return next;
    });
  }, []);
  const query = useSchedules(true);
  const now = useNow();
  if (model === null) {
    return <Notice back={back} text="定期ジョブが見つかりません。" />;
  }
  const name = safeText(schedule.name);
  return (
    <>
      <PageHeader title={name} subtitle={safeText(schedule.summary)}>
        <Breadcrumb items={originDiagramCrumbs(name, back)} />
      </PageHeader>
      <div className={SCROLL_BODY_CLASS}>
        {/* 幅を測る前は描かない。測る前に描くと、描き直しで見せ方が変わり、画面がちらつくため。 */}
        <div ref={widthRef} className="max-w-6xl">
          {width <= 0 ? null : (
            <OriginDiagramView
              model={model}
              run={originRunView(query, schedule.name, now)}
              width={width}
              expanded={expanded}
              onToggle={toggle}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 起動の図の画面の表示の部分。経路の名前と、データと、図を包む要素の実際の幅から描く。
 * 名前は一覧から探し、データに無い名前と安全でない名前は「見つかりません」とだけ書く。入力された名前は画面に書かない。
 */
export function OriginScreenView({
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
  const state = originRouteState(name, data);
  if (state.kind === "found" && data !== null) {
    return (
      <OriginBody
        schedule={state.schedule}
        data={data}
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
          ? "起動の図のデータを読み込めませんでした。"
          : "定期ジョブが見つかりません。"
      }
    />
  );
}

/** 起動の図の画面。経路の`:name`を読み、名前が無ければジョブの一覧へ戻す。 */
export function OriginScreen() {
  const params = useParams();
  const back = parseJobsBack(useLocation().state);
  const { ref, width } = useElementWidth();
  if (originRouteState(params.name, FLOWS_DATA).kind === "redirect") {
    return <Navigate to={JOBS_PATH} replace />;
  }
  return (
    <OriginScreenView
      name={params.name ?? ""}
      data={FLOWS_DATA}
      back={back}
      width={width}
      widthRef={ref}
    />
  );
}
