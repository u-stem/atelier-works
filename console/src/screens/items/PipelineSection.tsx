import { RefreshCw } from "lucide-react";
import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import {
  PIPELINE_DAYS,
  PIPELINE_LIMIT,
  usePipeline,
} from "../../api/queries.ts";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { TimeText } from "../../components/TimeText.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/cn.ts";
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
 * 作業項目の進捗の節。見出し、最終更新と再読み込み、取得の状態、表を持つ。
 * 作業項目の画面にある他の節と、取得も表示も共有しない。
 * 読み取り専用で、操作は起こさない。
 */
export function PipelineSection() {
  const pipeline = usePipeline();
  const now = useNow();
  const refresh = refreshStatusOf(pipeline);

  return (
    <section aria-labelledby="pipeline-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex items-center gap-2 text-small text-subtle">
          {refresh.isError ? (
            <span className="font-medium text-failure">更新に失敗しました</span>
          ) : null}
          {refresh.updatedAt > 0 ? (
            <TimeText
              iso={new Date(refresh.updatedAt).toISOString()}
              now={now}
              prefix="最終更新 "
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="進捗を再読み込み"
                aria-disabled={refresh.isFetching}
                onClick={refresh.isFetching ? undefined : refresh.onRefresh}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn(refresh.isFetching && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {refresh.isFetching ? "取得しています" : "再読み込み"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {pipeline.data === undefined ? (
        pipeline.isError ? (
          <FailureState error={pipeline.error} onRetry={refresh.onRefresh} />
        ) : (
          <LoadingState />
        )
      ) : (
        <PipelineTable rows={pipeline.data} now={now} />
      )}
    </section>
  );
}
