import type { ReactNode } from "react";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { QueryFailure } from "../items/QueryFailure.tsx";

/** 内容が未知の節の読み込み中の形。 */
const DEFAULT_SKELETON: LoadingShape = {
  rows: 3,
  rowClassName: "h-16 w-full rounded-xl",
};

/** 1つの枠にまとまる一覧の目安。通知と失敗の行3つ分(1行は約4.25rem)。 */
const LIST_SKELETON: LoadingShape = {
  rows: 1,
  rowClassName: "h-[12.75rem] w-full rounded-xl",
};

/**
 * 節ごとの読み込み中の形。節の見出しのidで引く。
 * 高さは、内容が出たときに下の節が動かないよう、内容の目安にそろえる。
 * 値は、行の余白と文字の高さから見積もった。実機で測り直して合わせる。
 */
export const SYSTEM_SKELETONS: Readonly<Record<string, LoadingShape>> = {
  // 有効な保留がなければ1行にたたまれる。
  "holds-heading": { rows: 1, rowClassName: "h-16 w-full rounded-xl" },
  // 3行の表(1行は約3rem)。
  "release-heading": { rows: 1, rowClassName: "h-36 w-full rounded-xl" },
  // 反映1件の枠(約7rem)を3つ。
  "update-history-heading": {
    rows: 3,
    rowClassName: "h-28 w-full rounded-xl",
  },
  // 注記1行と8行の表(1行は約3rem)。
  "worker-load-heading": {
    rows: 1,
    rowClassName: "h-[25rem] w-full rounded-xl",
  },
  "info-notices-heading": LIST_SKELETON,
  "resolved-notices-heading": LIST_SKELETON,
  "audit-failures-heading": LIST_SKELETON,
  "orphan-failures-heading": LIST_SKELETON,
};

/**
 * システムの画面の1つの節。見出し、取得の状態、本文を持つ。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 同じ取得を読む節は、結果を分け合う。
 * 節の枠は操作を持たない。操作を持つ節は、本文の側で書き込みを結ぶ。
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
  query: SectionQuery<T>;
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
      <LoadingGate
        phase={loadPhaseOf(query)}
        shape={SYSTEM_SKELETONS[id] ?? DEFAULT_SKELETON}
      >
        {query.data === undefined ? (
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
          <>
            {query.isError ? (
              <StaleDataNotice
                isFetching={query.isFetching}
                error={query.error}
                onRetry={() => {
                  void query.refetch();
                }}
              />
            ) : null}
            {children(query.data, now)}
          </>
        )}
      </LoadingGate>
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
