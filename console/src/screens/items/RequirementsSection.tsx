import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsIndexList } from "./RequirementsIndexList.tsx";

/**
 * 読み込み中の形。一覧の1行は約4.75rem(上下の余白と、題と補足の2行)で、1ページは10行になる。
 * 画面の高さに入る行の数で目安にする。値は見積もりで、実機で測り直して合わせる。
 */
const LOADING_SHAPE: LoadingShape = {
  rows: 6,
  rowClassName: "h-[4.75rem] w-full rounded-md",
  gapClassName: "gap-2",
};

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
      <LoadingGate phase={loadPhaseOf(index)} shape={LOADING_SHAPE}>
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
    </section>
  );
}
