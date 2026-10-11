import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { PIPELINE_DAYS, PIPELINE_LIMIT } from "../../api/queries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { pipelineScopeNote } from "../../lib/pipelineView.ts";
import { PipelineTable } from "./PipelineTable.tsx";

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" role="status">
      <span className="sr-only">読み込み中</span>
      {["a", "b", "c", "d", "e"].map((key) => (
        <Skeleton key={key} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}

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
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="text-small text-muted-foreground">
        上のバナーからログインすると、作業項目の進捗を表示します。
      </p>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>作業項目の進捗を取得できませんでした</AlertTitle>
      <AlertDescription>
        <p>
          {apiError === null ? "原因は不明です。" : describeApiError(apiError)}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          もう一度取得する
        </Button>
      </AlertDescription>
    </Alert>
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
      {pipeline.data === undefined ? (
        pipeline.isError ? (
          <FailureState
            error={pipeline.error}
            onRetry={() => {
              void pipeline.refetch();
            }}
          />
        ) : (
          <LoadingState />
        )
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
    </section>
  );
}
