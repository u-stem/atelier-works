import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useSummary } from "../api/queries.ts";
import { TimeText } from "../components/TimeText.tsx";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/cn.ts";
import { useNow } from "./useNow.ts";

const CLOCK_TICK_MS = 30_000;

/**
 * 各画面の見出し。右に「最終更新 n分前」と再読み込みのボタンを1つだけ置く。
 * 再読み込みは取得し直すだけで、画面の選択や絞り込みは変えない。
 */
export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  const summary = useSummary();
  const now = useNow(CLOCK_TICK_MS);
  const updatedAt = summary.dataUpdatedAt;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {children}
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {summary.isError ? (
          <span className="text-destructive">更新に失敗しました</span>
        ) : null}
        {updatedAt > 0 ? (
          <TimeText
            iso={new Date(updatedAt).toISOString()}
            now={now}
            prefix="最終更新 "
          />
        ) : (
          <span>まだ取得していません</span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={summary.isFetching}
          onClick={() => {
            void summary.refetch();
          }}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(summary.isFetching && "animate-spin")}
          />
          再読み込み
        </Button>
      </div>
    </header>
  );
}
