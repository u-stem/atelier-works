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
import { PAGE_HEADER_CLASS } from "../lib/layoutClasses.ts";
import { PAGE_HEADING_ID } from "../lib/routeFocus.ts";
import { AutoRefreshNote } from "./AutoRefreshNote.tsx";
import type { RefreshStatus } from "./refreshStatus.ts";
import { useNow } from "./useNow.ts";

/**
 * 各画面の見出し。題と短い副題を左に置く。
 * `refresh`を渡すと右側に最終更新と更新ボタンを置き、`actions`を渡すとその右に並べる。
 * 更新ボタンは画面全体を取り直すアイコンだけのボタン1つで、取得中は回る。
 * 画面が自分のクエリから`refresh`を作って渡す。取得するデータを持たない画面は渡さない。
 * 画面のすべての取得が自動で取り直されるときは、最終更新の脇に間隔を示す。
 * 更新は取得し直すだけで、画面の選択や絞り込みは変えない。
 * 画面の主要な操作は、題の下の`children`でなく`actions`に渡す。
 * 題(h1)は、画面の遷移の後にフォーカスの移し先になる。ページには見出しを1つだけ置く。
 */
export function PageHeader({
  title,
  subtitle,
  subtitleMono = false,
  refresh,
  refreshLabel = "この画面を更新",
  actions,
  children,
}: {
  title: string;
  subtitle?: string | null;
  /** 副題がID、SHA、ジョブIDのような識別子のとき、等幅で出す。 */
  subtitleMono?: boolean;
  refresh?: RefreshStatus;
  /** 更新ボタンの名前。更新が画面の一部だけを取り直すときは、取り直す範囲が分かる名前にする。 */
  refreshLabel?: string;
  /** 見出しの右端に置く主要な操作。`refresh`が無くても置く。 */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const now = useNow();
  const refreshControls =
    refresh === undefined ? null : (
      <RefreshControls
        refresh={refresh}
        refreshLabel={refreshLabel}
        now={now}
      />
    );
  // 幅が狭く右側が1行に1つへ折り返すと、見出しのjustify-betweenで左端へ戻る。
  // ml-autoで右端へ寄せ、中の並びもjustify-endで揃えて、折り返した行も右端に置く。
  // actionsが無い画面は、更新の塊をそのまま置き、描画を変えない。
  return (
    <header className={PAGE_HEADER_CLASS}>
      <div className="min-w-0">
        {/* 遷移の後にフォーカスを受ける。Tabの順には入れない。キーボードで移ったときだけ、移った先が分かるよう細い輪を描く。マウスの操作の後には描かない。 */}
        <h1
          id={PAGE_HEADING_ID}
          tabIndex={-1}
          className="truncate rounded-sm text-title font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </h1>
        {subtitle === undefined || subtitle === null ? null : (
          <p
            className={cn(
              "text-small text-muted-foreground tabular-nums",
              subtitleMono && "font-mono",
            )}
          >
            {subtitle}
          </p>
        )}
        {children}
      </div>
      {actions === undefined ? (
        refreshControls
      ) : (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {refreshControls}
          {actions}
        </div>
      )}
    </header>
  );
}

function RefreshControls({
  refresh,
  refreshLabel,
  now,
}: {
  refresh: RefreshStatus;
  refreshLabel: string;
  now: number;
}) {
  return (
    <div className="flex items-center gap-2 text-small whitespace-nowrap text-subtle">
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
      <AutoRefreshNote
        intervalMs={refresh.autoRefreshMs}
        failed={refresh.isError}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={refreshLabel}
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
          {refresh.isFetching ? "取得しています" : refreshLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
