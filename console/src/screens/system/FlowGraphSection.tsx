import { useMemo, useState } from "react";
import { useNow } from "../../app/useNow.ts";
import { Disclosure } from "../../components/Disclosure.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import { graphPresentation } from "../../lib/flowGraphFit.ts";
import { layoutExtent, layoutFlowGraph } from "../../lib/flowGraphLayout.ts";
import {
  type FlowGraphReads,
  type FlowGraphState,
  flowGraphStateOf,
} from "../../lib/flowOverlay.ts";
import { useElementWidth } from "../../lib/useElementWidth.ts";
import { FlowGraphDiagram, FlowGraphList } from "../jobs/FlowGraphDiagram.tsx";
import {
  ACTIVE_READ_FAILED_NOTE,
  overviewWords,
  QUEUE_TRUNCATED_NOTE,
  SCHEDULE_READ_FAILED_NOTE,
  SCHEDULE_TRUNCATED_NOTE,
} from "../jobs/flowGraphText.ts";

function GraphNote({ text }: { text: string }) {
  return (
    <Alert variant="warning">
      <AlertDescription>
        <p>{text}</p>
      </AlertDescription>
    </Alert>
  );
}

/** 節の実際の幅から、図の見せ方を決める。図の幅はグラフから求める。 */
function usePresentation(graph: FlowGraph, width: number) {
  const extentWidth = useMemo(
    () => layoutExtent(layoutFlowGraph(graph)).width,
    [graph],
  );
  return graphPresentation(width, extentWidth);
}

/**
 * 図の本体。節の実際の幅`width`(px)から、見せ方を選ぶ。
 * 図の幅とカードの分が収まれば図をそのまま、収まらなければ横にスクロールできる枠に入れる。
 * 枠は、キーボードで焦点を当てないと隠れた部分を読めないので、焦点を受けられるようにする。
 * 640px未満は図が読めないので、flowごとの一覧にする。一覧は、定期の入口を描かないので、その注記も出さない。
 * 図の上に、実行中と待ちの要約を1行置く。強調が無いだけでは、読み込み前と何も動いていない状態を見分けられないためである。
 * 実行中と待ちの取得に失敗したときは、強調を外し、読めなかったと伝える。
 * キューが切れているときは、強調の無いflowも動いている場合があると伝える。
 */
export function FlowGraphBody({
  graph,
  state,
  width,
}: {
  graph: FlowGraph;
  state: FlowGraphState;
  width: number;
}) {
  const presentation = usePresentation(graph, width);
  const overview = overviewWords(state);
  const showsSchedules = presentation !== "list";
  return (
    <div className="flex flex-col gap-3">
      {overview === null ? null : (
        <p role="status" className="text-small font-medium">
          {overview}
        </p>
      )}
      {state.activeFailed ? <GraphNote text={ACTIVE_READ_FAILED_NOTE} /> : null}
      {state.overlay?.lowerBound === true ? (
        <GraphNote text={QUEUE_TRUNCATED_NOTE} />
      ) : null}
      {showsSchedules && state.schedulesFailed ? (
        <GraphNote text={SCHEDULE_READ_FAILED_NOTE} />
      ) : null}
      {showsSchedules && state.schedulesTruncated ? (
        <GraphNote text={SCHEDULE_TRUNCATED_NOTE} />
      ) : null}
      {presentation === "list" ? (
        <FlowGraphList graph={graph} state={state} />
      ) : presentation === "fit" ? (
        <div className="rounded-xl border border-border bg-card p-2">
          <FlowGraphDiagram graph={graph} state={state} />
        </div>
      ) : (
        // 横にスクロールできる領域は、キーボードで焦点を当てないと読み進められない。
        // biome-ignore lint/a11y/useSemanticElements: 領域の役割を明示する。sectionは、見出しを持つ節と取り違えられる。
        <div
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上。
          tabIndex={0}
          aria-label="起動の関係の図(横にスクロールできます)"
          className="overflow-x-auto rounded-xl border border-border bg-card p-2 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FlowGraphDiagram graph={graph} state={state} />
        </div>
      )}
    </div>
  );
}

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

/**
 * 起動の関係の節。スケジュール、script、flow、人の操作が何を起動するかを図にし、実行中のflowを重ねる。
 * 図は自前のSVGで描く。データはバンドルに取り込んだ静的なJSONで、外部の入力を含まない。
 * 実行の状態は、実行中と待ちのジョブとscheduleの取得から重ねる。
 * 取得は画面が持ち、図を開いた後にだけ始める。見出しの更新にも、その後から含める。
 * 図は重く、普段は読まないので、たたんで置く。開いたときに初めて描画し、一度描いた後は閉じても残す。
 * 図の幅は広いので、ほかの節より広く取る。
 * 幅は節の全体で測る。図が出ない狭い幅では、図の説明も出さない。
 */
export function FlowGraphSectionView({
  graph,
  initiallyOpen,
  reads,
  onOpen,
  width,
  widthRef,
  nowMs,
}: {
  graph: FlowGraph | null;
  initiallyOpen?: boolean | undefined;
  /** 実行の状態の取得。渡さなければ、構造だけを描く。 */
  reads?: FlowGraphReads | undefined;
  /** 「図を表示」を開いたときに呼ぶ。取得を始める合図に使う。 */
  onOpen?: (() => void) | undefined;
  /** 節の実際の幅(px)。 */
  width: number;
  /** 節の幅を測る要素の`ref`。 */
  widthRef?:
    | ((element: HTMLElement | null) => (() => void) | undefined)
    | undefined;
  nowMs: number;
}) {
  const [opened, setOpened] = useState(initiallyOpen === true);
  const state = flowGraphStateOf(reads, nowMs);
  const presentation = usePresentation(graph ?? EMPTY_GRAPH, width);
  return (
    <section
      ref={widthRef}
      aria-labelledby="flow-graph-heading"
      className="flex max-w-6xl flex-col gap-3"
    >
      <div className="min-w-0">
        <h2
          id="flow-graph-heading"
          tabIndex={-1}
          className="scroll-mt-4 rounded-sm text-lead font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          起動の関係
        </h2>
        <div className="text-small text-muted-foreground">
          {presentation === "list" ? (
            <>
              flowごとに、実行中か、待っているジョブがあるかを示します。
              起動の関係の図は、幅の広い画面で表示します。
            </>
          ) : (
            <>
              スケジュール、script、flow、人の操作が、何を起動するかを示します。
              実線の矢印はscriptがflowを起動する関係、破線の矢印は時刻や人の操作による起動、点線の矢印はflowが実行するステップです。
              scriptからscriptの起動は含みません。
              たとえばself_updateがauto_retry_stale_imageを起動する関係は、図に出ません。
              実行中のflowは強調し、待っているジョブの数を添えます。
              定期の入口には、停止中か、直近の実行の成否と次回の予定を添えます。
            </>
          )}
        </div>
      </div>
      {graph === null ? (
        <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          起動の関係のデータを読み込めませんでした。
        </p>
      ) : (
        <Disclosure
          summary="図を表示"
          initiallyOpen={initiallyOpen === true}
          onToggle={(open) => {
            if (open) {
              setOpened(true);
              onOpen?.();
            }
          }}
        >
          {opened ? (
            <FlowGraphBody graph={graph} state={state} width={width} />
          ) : null}
        </Disclosure>
      )}
    </section>
  );
}

/** 起動の関係の節。幅と現在時刻を測って、表示の部分に渡す。 */
export function FlowGraphSection(props: {
  graph: FlowGraph | null;
  initiallyOpen?: boolean | undefined;
  reads?: FlowGraphReads | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const { ref, width } = useElementWidth();
  const nowMs = useNow();
  return (
    <FlowGraphSectionView
      {...props}
      width={width}
      widthRef={ref}
      nowMs={nowMs}
    />
  );
}
