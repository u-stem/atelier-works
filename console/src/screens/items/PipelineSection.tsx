import { isBannerError } from "../../api/errors.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { PIPELINE_DAYS, PIPELINE_LIMIT } from "../../api/queries.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { pipelineScopeNote } from "../../lib/pipelineView.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { PipelineTable } from "./PipelineTable.tsx";

/**
 * 読み込み中の形。表の1行は約3rem(上下の余白と、題の1〜2行)で、1ページは25行になる。
 * 画面の高さに入る行の数で目安にする。値は見積もりで、実機で測り直して合わせる。
 */
const LOADING_SHAPE: LoadingShape = {
  rows: 8,
  rowClassName: "h-12 w-full rounded-md",
  gapClassName: "gap-2",
};

/**
 * 取得に失敗して表示できる一覧が無いときの表示。
 * 401は画面上部のバナーが知らせるので、同じ内容の警告を重ねない。
 */
function FailureState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const apiError = apiErrorOf(error);
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="text-small text-muted-foreground">
        上のバナーからログインすると、作業項目の進捗を表示します。
      </p>
    );
  }
  return (
    <QueryFailureAlert
      title="作業項目の進捗を取得できませんでした"
      error={error}
      onRetry={onRetry}
    />
  );
}

/**
 * 作業項目の進捗の節。見出し、取得の状態、表を持つ。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 読み取り専用で、操作は起こさない。
 */
export function PipelineSection({
  pipeline,
}: {
  pipeline: SectionQuery<PipelineRow[]>;
}) {
  const now = useNow();

  return (
    <section aria-labelledby="pipeline-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="pipeline-heading" className="text-lead font-semibold">
          進捗
        </h2>
        <p className="text-small text-muted-foreground">
          {pipeline.data === undefined
            ? "作業項目の状態、ブランチ、PRを一覧します。"
            : pipelineScopeNote(
                pipeline.data.length,
                PIPELINE_LIMIT,
                PIPELINE_DAYS,
              )}
        </p>
      </div>
      <LoadingGate phase={loadPhaseOf(pipeline)} shape={LOADING_SHAPE}>
        {pipeline.data === undefined ? (
          <FailureState
            error={pipeline.error}
            onRetry={() => {
              void pipeline.refetch();
            }}
          />
        ) : (
          <>
            {pipeline.isError ? (
              <StaleDataNotice
                error={pipeline.error}
                isFetching={pipeline.isFetching}
                onRetry={() => {
                  void pipeline.refetch();
                }}
              />
            ) : null}
            <PipelineTable rows={pipeline.data} now={now} />
          </>
        )}
      </LoadingGate>
    </section>
  );
}
