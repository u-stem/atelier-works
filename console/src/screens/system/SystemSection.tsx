import type { UseQueryResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/cn.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">読み込み中</span>
      {["a", "b", "c"].map((key) => (
        <Skeleton key={key} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * システムの画面の1つの節。見出し、最終更新と再読み込み、取得の状態、本文を持つ。
 * 取得は節ごとに持つ。同じ取得を読む節は、キャッシュと再読み込みを分け合う。
 * 読み取り専用で、操作は起こさない。
 */
export function SystemSection<T>({
  id,
  title,
  description,
  query,
  loginHint,
  children,
}: {
  /** 見出しの要素のid。節の`aria-labelledby`が指す。 */
  id: string;
  title: string;
  description: ReactNode;
  query: UseQueryResult<T, Error>;
  /** 401で取得できないときに、ログイン後に何が出るかを伝える文。 */
  loginHint: string;
  /** 取得できた値から本文を描く。 */
  children: (data: T, now: number) => ReactNode;
}) {
  const now = useNow();
  const refresh = refreshStatusOf(query);
  return (
    <section aria-labelledby={id} className="flex max-w-3xl flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-lead font-semibold">
            {title}
          </h2>
          <div className="text-small text-muted-foreground">{description}</div>
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
                aria-label={`${title}を再読み込み`}
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
      {query.data === undefined ? (
        query.isError ? (
          <QueryFailure
            compact
            title={`${title}を取得できませんでした`}
            loginHint={loginHint}
            error={query.error}
            onRetry={refresh.onRefresh}
          />
        ) : (
          <LoadingState />
        )
      ) : (
        children(query.data, now)
      )}
    </section>
  );
}

/** 節の本文が空のときの表示。 */
export function EmptyNote({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
      {children}
    </p>
  );
}
