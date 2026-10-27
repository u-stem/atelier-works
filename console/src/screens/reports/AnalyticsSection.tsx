import type { ReactNode } from "react";
import { isBannerError } from "../../api/errors.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import {
  LoadingGate,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { apiErrorOf } from "../../lib/queryFailureView.ts";

/** 棒グラフ1つ(題と描画の領域)の骨組み。実機で測った実物は222px。 */
function ChartBlock() {
  return <Skeleton className="h-[13.86rem] w-full rounded-xl" />;
}

/**
 * 区画ごとの読み込み中の形。実物は区画の中の塊を24pxあけて並べ、塊の数と高さが区画で違う。
 * 寸法は、実機で実物を描いて測った値で、表の高さは行の数で変わる(表は最大256pxで切れる)。
 * - Claudeの実行: 棒グラフ2つ(各222px)と表(256px)で748px。
 * - 承認: 集計(92px)と表(297px)で413px。
 * - リードタイム: 棒グラフ1つ(222px)と表(68px)で313px。
 */
export const ANALYTICS_COST_LOADING_SHAPE: LoadingShape = {
  className: "flex flex-col gap-6",
  node: (
    <>
      <ChartBlock />
      <ChartBlock />
      <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />
    </>
  ),
};

export const ANALYTICS_APPROVALS_LOADING_SHAPE: LoadingShape = {
  className: "flex flex-col gap-6",
  node: (
    <>
      <Skeleton className="h-[5.74rem] w-full max-w-3xl rounded-xl" />
      <Skeleton className="h-[18.6rem] w-full max-w-3xl rounded-xl" />
    </>
  ),
};

export const ANALYTICS_LEAD_TIME_LOADING_SHAPE: LoadingShape = {
  className: "flex flex-col gap-6",
  node: (
    <>
      <ChartBlock />
      <Skeleton className="h-[4.2rem] w-full max-w-3xl rounded-xl" />
    </>
  ),
};

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
  const apiError = apiErrorOf(error);
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="text-small text-muted-foreground">
        上のバナーからログインすると、{title}を表示します。
      </p>
    );
  }
  return (
    <QueryFailureAlert
      title={`${title}を取得できませんでした`}
      error={error}
      onRetry={onRetry}
      className="max-w-3xl"
    />
  );
}

/**
 * 分析の1区画。取得中、失敗、空、値ありの4つを区別して出す。
 * 取得中は値が無いので、空の表示を出さない。
 * 再取得に失敗しても前回の値が残っているときは、空かどうかによらず、値を出したまま、古いことと再取得の操作を添える。
 */
export function AnalyticsSection<T>({
  id,
  title,
  failureTitle,
  emptyMessage,
  query,
  loadingShape,
  children,
}: {
  id: string;
  title: string;
  failureTitle: string;
  emptyMessage: string;
  query: SectionQuery<T[]>;
  /** 取得を待つ間の形。区画の実物の塊に合わせて渡す。 */
  loadingShape: LoadingShape;
  children: (rows: T[]) => ReactNode;
}) {
  const rows = query.data;
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <h3 id={id} className="mb-4 text-lead font-semibold">
        {title}
      </h3>
      <LoadingGate phase={loadPhaseOf(query)} shape={loadingShape}>
        {rows === undefined ? (
          <FailureState
            title={failureTitle}
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {query.isError ? (
              <StaleDataNotice
                error={query.error}
                isFetching={query.isFetching}
                onRetry={() => {
                  void query.refetch();
                }}
              />
            ) : null}
            {rows.length === 0 ? (
              <p className="max-w-3xl rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
                {emptyMessage}
              </p>
            ) : (
              children(rows)
            )}
          </div>
        )}
      </LoadingGate>
    </section>
  );
}
