import { isBannerError } from "../../api/errors.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { PIPELINE_DAYS, PIPELINE_LIMIT } from "../../api/queries.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
  rowIndexes,
  SkeletonListCard,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  type PipelineScope,
  pipelineReachedLimit,
  pipelineScopeNote,
} from "../../lib/pipelineView.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { PipelineTable } from "./PipelineTable.tsx";

/**
 * 読み込み中の形。実物の絞り込みの帯、件数の行、表(狭い幅ではカード)の順に並べる。
 * 寸法は、実機で実物を描いて測った値である。
 * - 絞り込みの帯: 広い幅で61px、狭い幅で186px(縦に積む)。
 * - 件数の行: 21px。
 * - 表の見出し: 37px。表の1行: 42〜67px(題が2行のとき、PRのリンクがあるとき)で、平均54px。
 * - 狭い幅のカード: 187〜235px。平均200px。
 * 行の数は、画面の高さに入る目安で、実物の1ページ(25行)より少ない。
 * 表とカードの切り替えは、実物と同じ`@4xl`の幅(コンテナ)で行う。
 */
export const PIPELINE_LOADING_SHAPE: LoadingShape = {
  className: "flex flex-col gap-3",
  node: (
    <>
      <Skeleton className="h-[11.6rem] lg:h-[3.8rem] w-full rounded-lg" />
      <Skeleton className="h-5 w-24" />
      <div className="@container">
        <SkeletonListCard
          rows={3}
          rowClassName="h-[12.5rem]"
          className="@4xl:hidden"
        />
        <div className="hidden overflow-hidden rounded-xl border border-border bg-card @4xl:block">
          <Skeleton className="h-[2.3rem] w-full rounded-none" />
          {rowIndexes(8).map((row) => (
            <div
              key={row}
              className="flex h-[3.375rem] items-center border-t border-border px-3"
            >
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    </>
  ),
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
 * 進捗のタブの本体。範囲の注記、取得の状態、表を持つ。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 読み取り専用で、操作は起こさない。
 */
export function PipelineSection({
  pipeline,
  scope,
  onScopeChange,
}: {
  pipeline: SectionQuery<PipelineRow[]>;
  /** 表に出す範囲。 */
  scope: PipelineScope;
  /** 範囲を替えたときに呼ぶ。 */
  onScopeChange: (scope: PipelineScope) => void;
}) {
  const now = useNow();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-muted-foreground">
        {pipeline.data === undefined
          ? "作業項目の状態、ブランチ、PRを一覧します。"
          : pipelineScopeNote(
              pipeline.data.length,
              PIPELINE_LIMIT,
              PIPELINE_DAYS,
            )}
      </p>
      <LoadingGate phase={loadPhaseOf(pipeline)} shape={PIPELINE_LOADING_SHAPE}>
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
            <PipelineTable
              rows={pipeline.data}
              now={now}
              scope={scope}
              onScopeChange={onScopeChange}
              limitReached={pipelineReachedLimit(
                pipeline.data.length,
                PIPELINE_LIMIT,
              )}
            />
          </>
        )}
      </LoadingGate>
    </div>
  );
}
