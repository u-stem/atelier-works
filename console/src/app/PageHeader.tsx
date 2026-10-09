import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { TimeText } from "../components/TimeText.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import type { RefreshStatus } from "./refreshStatus.ts";
import { useNow } from "./useNow.ts";

/**
 * 各画面の見出し。題と短い副題を左に、`refresh`を渡すと右に最終更新と再読み込みを置く。
 * 再読み込みはアイコンだけのボタン1つで、取得中は回る。
 * 画面が自分のクエリから`refresh`を作って渡す。取得するデータを持たない画面は渡さない。
 * 再読み込みは取得し直すだけで、画面の選択や絞り込みは変えない。
 */
export function PageHeader({
  title,
  subtitle,
  refresh,
  children,
}: {
  title: string;
  subtitle?: string | null;
  refresh?: RefreshStatus;
  children?: ReactNode;
}) {
  const now = useNow();
  return (
    <header className="flex min-h-[4.5rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-8 py-4">
      <div className="min-w-0">
        <h1 className="truncate text-title font-semibold tracking-tight">
          {title}
        </h1>
        {subtitle === undefined || subtitle === null ? null : (
          <p className="text-small text-muted-foreground tabular-nums">
            {subtitle}
          </p>
        )}
        {children}
      </div>
      {refresh === undefined ? null : (
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
          ) : (
            <span>まだ取得していません</span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="再読み込み"
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
      )}
    </header>
  );
}
