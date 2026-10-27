import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
  SkeletonListCard,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsIndexList } from "./RequirementsIndexList.tsx";

/**
 * 読み込み中の形。実物の絞り込みの行(入力欄36px)と、枠で囲んだ一覧を並べる。
 * 寸法は、実機で実物を描いて測った値で、一覧の1行は広い幅で81px、狭い幅(題が折り返す幅)で106px。
 * 行の数は、画面の高さに入る目安で、実物の1ページ(10行)より少ない。
 */
export const REQUIREMENTS_LOADING_SHAPE: LoadingShape = {
  className: "flex flex-col gap-4",
  node: (
    <>
      <Skeleton className="h-9 w-80 max-w-full rounded-lg" />
      <SkeletonListCard rows={6} rowClassName="h-[6.6rem] sm:h-[5.05rem]" />
    </>
  ),
};

/**
 * 要件定義のタブの本体。要件定義がある作業項目を新しい順に並べ、行から要件定義書へ移る。
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
    <div className="flex flex-col gap-3">
      <LoadingGate
        phase={loadPhaseOf(index)}
        shape={REQUIREMENTS_LOADING_SHAPE}
      >
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
        ) : (
          <QueryFailure
            compact
            title="要件定義の一覧を取得できませんでした"
            loginHint="上のバナーからログインすると、要件定義の一覧を表示します。"
            error={index.error}
            onRetry={() => {
              void index.refetch();
            }}
          />
        )}
      </LoadingGate>
    </div>
  );
}
