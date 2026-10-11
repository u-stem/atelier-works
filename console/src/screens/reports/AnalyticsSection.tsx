import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

/**
 * 取得に失敗して表示できる値が無いときの表示。
 * 401は画面上部のバナーが知らせるので、同じ内容の警告を重ねない。
 */
function FailureState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="text-small text-muted-foreground">
        上のバナーからログインすると、{title}を表示します。
      </p>
    );
  }
  return (
    <Alert variant="destructive" className="max-w-3xl">
      <AlertTitle>{title}を取得できませんでした</AlertTitle>
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
 * 分析の1区画。取得中、失敗、空、値ありの4つを区別して出す。
 * 取得中は値が無いので、空の表示を出さない。
 * 再取得に失敗しても前回の値が残っているときは、値を出したまま、古いことを添える。
 */
export function AnalyticsSection<T>({
  id,
  title,
  failureTitle,
  emptyMessage,
  query,
  children,
}: {
  id: string;
  title: string;
  failureTitle: string;
  emptyMessage: string;
  query: UseQueryResult<T[], Error>;
  children: (rows: T[]) => ReactNode;
}) {
  const rows = query.data;
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <h3 id={id} className="mb-4 text-lead font-semibold">
        {title}
      </h3>
      {rows === undefined ? (
        query.isError ? (
          <FailureState
            title={failureTitle}
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <LoadingState />
        )
      ) : rows.length === 0 ? (
        <p className="max-w-3xl rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {query.isError ? (
            <p className="text-small text-warning">
              最新の取得に失敗したため、前回取得した値を表示しています。
            </p>
          ) : null}
          {children(rows)}
        </div>
      )}
    </section>
  );
}
