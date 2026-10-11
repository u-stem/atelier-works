import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsIndexList } from "./RequirementsIndexList.tsx";

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" role="status">
      <span className="sr-only">読み込み中</span>
      {["a", "b", "c", "d"].map((key) => (
        <Skeleton key={key} className="h-14 w-full rounded-md" />
      ))}
    </div>
  );
}

/**
 * 要件定義の節。要件定義がある作業項目を新しい順に並べ、行から要件定義書へ移る。
 * 取得は画面が持ち、更新ボタンも画面の見出しにある。この節は失敗したときの「もう一度取得する」だけを持つ。
 * 読み取り専用で、操作は起こさない。
 */
export function RequirementsSection({
  index,
}: {
  index: SectionQuery<readonly RequirementsIndexRow[]>;
}) {
  const now = useNow();
  const rows = index.data;
  return (
    <section
      aria-labelledby="requirements-heading"
      className="flex flex-col gap-3"
    >
      <div>
        <h2 id="requirements-heading" className="text-lead font-semibold">
          要件定義
        </h2>
        <p className="text-small text-muted-foreground">
          {rows === undefined
            ? "要件定義がある作業項目を一覧します。"
            : `要件定義がある作業項目 ${rows.length}件`}
        </p>
      </div>
      {rows !== undefined ? (
        <>
          {index.isError ? (
            <StaleDataNotice
              error={index.error}
              isFetching={index.isFetching}
              onRetry={() => {
                void index.refetch();
              }}
            />
          ) : null}
          <RequirementsIndexList rows={rows} now={now} />
        </>
      ) : index.isError ? (
        <QueryFailure
          compact
          title="要件定義の一覧を取得できませんでした"
          loginHint="上のバナーからログインすると、要件定義の一覧を表示します。"
          error={index.error}
          onRetry={() => {
            void index.refetch();
          }}
        />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}
