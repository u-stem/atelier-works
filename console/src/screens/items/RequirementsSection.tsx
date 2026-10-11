import { RefreshCw } from "lucide-react";
import { useRequirementsIndex } from "../../api/queries.ts";
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
 * 作業項目の画面にある他の節と、取得も表示も共有しない。
 * 読み取り専用で、操作は起こさない。
 */
export function RequirementsSection() {
  const index = useRequirementsIndex();
  const now = useNow();
  const refresh = refreshStatusOf(index);
  const rows = index.data;
  return (
    <section
      aria-labelledby="requirements-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
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
                aria-label="要件定義を再読み込み"
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
      {rows !== undefined ? (
        <RequirementsIndexList rows={rows} now={now} />
      ) : index.isError ? (
        <QueryFailure
          compact
          title="要件定義の一覧を取得できませんでした"
          loginHint="上のバナーからログインすると、要件定義の一覧を表示します。"
          error={index.error}
          onRetry={refresh.onRefresh}
        />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}
