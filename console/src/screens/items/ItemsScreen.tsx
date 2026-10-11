import { useRequirementsIndex } from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsIndexList } from "./RequirementsIndexList.tsx";

function LoadingState() {
  return (
    <div
      className="mx-auto w-full max-w-[60rem] space-y-3 px-8 py-6"
      role="status"
    >
      <span className="sr-only">読み込み中</span>
      {["a", "b", "c", "d"].map((key) => (
        <div
          key={key}
          className="space-y-2 rounded-xl border border-border p-4"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/**
 * 作業項目の画面。要件定義がある作業項目を新しい順に並べ、行から要件定義書へ移る。
 */
export function ItemsScreen() {
  const index = useRequirementsIndex();
  const now = useNow();
  const refresh = refreshStatusOf(index);
  const rows = index.data;
  return (
    <>
      <PageHeader
        title="作業項目"
        subtitle={
          rows === undefined ? null : `要件定義がある作業項目 ${rows.length}件`
        }
        refresh={refresh}
      />
      {rows !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RequirementsIndexList rows={rows} now={now} />
        </div>
      ) : index.isError ? (
        <QueryFailure
          title="要件定義の一覧を取得できませんでした"
          loginHint="上のバナーからログインすると、要件定義の一覧を表示します。"
          error={index.error}
          onRetry={refresh.onRefresh}
        />
      ) : (
        <LoadingState />
      )}
    </>
  );
}
