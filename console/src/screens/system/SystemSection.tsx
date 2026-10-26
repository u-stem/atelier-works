import type { ReactNode } from "react";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { LoadingGate, type RowsShape } from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { QueryFailure } from "../items/QueryFailure.tsx";

/** 内容が未知の節の読み込み中の形。 */
const DEFAULT_SKELETON: RowsShape = {
  rows: 3,
  rowClassName: "h-16 w-full rounded-xl",
};

/**
 * 節ごとの読み込み中の形。節の見出しのidで引く。
 * 高さは、内容が出たときに下の節が動かないよう、実機で測った本文の高さ(説明の下から節の終わりまで)にそろえる。
 * 一覧は件数で変わるので、よくある件数の高さにそろえる。測った内容は、各行のコメントに書く。
 */
export const SYSTEM_SKELETONS: Readonly<Record<string, RowsShape>> = {
  // 有効な保留がなければ1行にたたまれる(63px)。
  "holds-heading": { rows: 1, rowClassName: "h-16 w-full rounded-xl" },
  // 3行の表(145px)。
  "release-heading": { rows: 1, rowClassName: "h-36 w-full rounded-xl" },
  // 結論の1行の枠と、「内訳を表示」の1行(98px)。
  "worker-load-heading": {
    rows: 1,
    rowClassName: "h-[6.125rem] w-full rounded-xl",
  },
  // 「すべて表示」のボタンと、新しい3件の枠(12件で528px)。
  "update-history-heading": {
    rows: 1,
    rowClassName: "h-[33rem] w-full rounded-xl",
  },
  // 一覧を開く1行(36px)。通知が無いときは空の旨の1行(63px)になる。
  "info-notices-heading": {
    rows: 1,
    rowClassName: "h-9 w-full rounded-xl",
  },
  // 失敗1件の枠(約137px)。件数はたいてい少ない。
  "audit-failures-heading": {
    rows: 1,
    rowClassName: "h-[8.6rem] w-full rounded-xl",
  },
  // 件数の行と、flow4つの折りたたみ(317px)。
  "orphan-failures-heading": {
    rows: 1,
    rowClassName: "h-[19.8rem] w-full rounded-xl",
  },
  // 履歴を開く1行(36px)。
  "resolved-notices-heading": {
    rows: 1,
    rowClassName: "h-9 w-full rounded-xl",
  },
};

/**
 * システムの画面の1つの節。見出し、取得の状態、本文を持つ。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 同じ取得を読む節は、結果を分け合う。
 * 見出しの横に、その取得の最終取得時刻を出す。取得ごとに鮮度が違うためである。
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
  const updatedAt = query.dataUpdatedAt;
  return (
    <section aria-labelledby={id} className="flex max-w-3xl flex-col gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3">
          {/* 要約の帯のリンクで移った後にフォーカスを受ける。Tabの順には入れない。 */}
          <h2
            id={id}
            tabIndex={-1}
            className="scroll-mt-4 rounded-sm text-lead font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h2>
          {updatedAt === undefined || updatedAt <= 0 ? null : (
            <span className="text-small text-subtle">
              <TimeText
                iso={new Date(updatedAt).toISOString()}
                now={now}
                prefix="取得 "
              />
            </span>
          )}
        </div>
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
