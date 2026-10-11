import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNow } from "../../app/useNow.ts";
import { Skeleton } from "../../components/ui/skeleton.tsx";
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
 * システムの画面の1つの節。見出し、取得の状態、本文を持つ。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 同じ取得を読む節は、結果を分け合う。
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
  return (
    <section aria-labelledby={id} className="flex max-w-3xl flex-col gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-lead font-semibold">
          {title}
        </h2>
        <div className="text-small text-muted-foreground">{description}</div>
      </div>
      {query.data === undefined ? (
        query.isError ? (
          <QueryFailure
            compact
            title={`${title}を取得できませんでした`}
            loginHint={loginHint}
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
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
