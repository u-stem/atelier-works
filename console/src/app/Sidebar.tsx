import { useQueryClient } from "@tanstack/react-query";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router";
import { useConsoleStatus } from "../api/consoleStatus.ts";
import { useSummary } from "../api/queries.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import { describeRelease } from "../lib/consoleStatus.ts";
import { actionableCounts } from "../lib/inboxView.ts";
import { TRANSITION_WIDTH } from "../lib/motionClasses.ts";
import {
  formatBadgeCount,
  menuButtonLabel,
  navLinkClass,
  nextNavFocusIndex,
  parseSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
} from "../lib/navigation.ts";
import {
  createPrefetchScheduler,
  handlePress,
  PREFETCH_COOLDOWN_MS,
  type PressEvent,
} from "../lib/prefetchSchedule.ts";
import { NavDrawer } from "./NavDrawer.tsx";
import { SCREENS, type ScreenId } from "./screens.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { useNow } from "./useNow.ts";

function readCollapsed(): boolean {
  try {
    return parseSidebarCollapsed(
      window.localStorage.getItem(SIDEBAR_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

/** 保存できない環境(プライベートブラウズなど)でも、この画面の表示は切り替わる。 */
function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // 保存できなくても、この画面の表示はすでに切り替わっている。
  }
}

/** 配信している版と、取り込みの最後の確認。取れた情報だけを出し、取れなければ何も出さない。 */
function ReleaseInfo() {
  const status = useConsoleStatus();
  const now = useNow();
  const release = status === null ? null : describeRelease(status, now);
  if (release === null) {
    return null;
  }
  return (
    <p className="text-caption leading-5 text-subtle">
      {release.versionLabel === null ? null : (
        <span className="font-medium text-muted-foreground tabular-nums">
          {release.versionLabel}
        </span>
      )}
      {release.versionLabel === null ? null : "・"}
      <span className="tabular-nums">{release.checkedLabel}</span>
      {release.warning === null ? null : (
        <span className="mt-1 block font-medium text-notice">
          {release.warning}
        </span>
      )}
    </p>
  );
}

/**
 * 入口の押下で、その画面の初回の取得を先読みする関数を返す。
 * 押してから離すまでの時間を、取得に使う。
 * focusとhoverでは先読みしない。矢印やTabで入口をたどるだけで、Windmillのジョブが溜まるためである。
 * 判定は`lib/prefetchSchedule.ts`の純関数が行う。
 * 先読みは、各画面の取得と同じ設定(キー、関数、`staleTime`)で行う。
 * 新しいデータは取り直さず、走っている取得には重ねない。
 */
function usePrefetchOnPress(): (id: ScreenId, event: PressEvent) => void {
  const client = useQueryClient();
  const scheduler = useMemo(
    () =>
      createPrefetchScheduler<ScreenId>({
        cooldownMs: PREFETCH_COOLDOWN_MS,
        now: () => Date.now(),
        run: (id) => {
          const screen = SCREENS.find((candidate) => candidate.id === id);
          for (const options of screen?.prefetch() ?? []) {
            void client.prefetchQuery(options);
          }
        },
      }),
    [client],
  );
  return (id, event) => {
    handlePress(scheduler, id, event);
  };
}

/**
 * 4つの入口と件数のリスト。入口の間は、上下の矢印とHome・Endで移れる。
 * `onNavigate`は、入口を選んだときに呼ぶ。ドロワーを閉じるために使う。
 */
function NavList({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const summary = useSummary();
  const navRef = useRef<HTMLElement>(null);
  const prefetchScreen = usePrefetchOnPress();

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const links = Array.from(navRef.current?.querySelectorAll("a") ?? []);
    // biomeはindexOfを勧めるが、activeElementはElement | nullで、indexOfの引数の型に合わない。
    const current = links.findIndex((link) => link === document.activeElement);
    const next = nextNavFocusIndex(event.key, current, links.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    links[next]?.focus();
  };

  return (
    <nav
      ref={navRef}
      aria-label="メインメニュー"
      className="flex flex-col gap-1 px-3 pt-2"
      onKeyDown={handleKeyDown}
    >
      {SCREENS.map((screen) => {
        const Icon = screen.icon;
        const badge = formatBadgeCount(
          screen.badge(
            summary.data === undefined
              ? undefined
              : actionableCounts(summary.data),
          ),
        );
        return (
          <Tooltip key={screen.id}>
            <TooltipTrigger asChild>
              <NavLink
                to={screen.path}
                end={screen.path === "/"}
                className={navLinkClass(collapsed)}
                onClick={onNavigate}
                onPointerDown={(event) => {
                  prefetchScreen(screen.id, {
                    pointerType: event.pointerType,
                    button: event.button,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                  });
                }}
              >
                <span className="relative inline-flex shrink-0">
                  <Icon aria-hidden="true" className="size-[18px]" />
                  {collapsed && badge !== null ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-2 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums"
                    >
                      {badge}
                    </span>
                  ) : null}
                </span>
                <span className={cn("flex-1 truncate", collapsed && "sr-only")}>
                  {screen.label}
                </span>
                {badge === null ? null : (
                  <span
                    className={cn(
                      "rounded-full bg-primary px-2 text-caption leading-5 font-semibold text-primary-foreground tabular-nums",
                      collapsed && "sr-only",
                    )}
                  >
                    {badge}
                    <span className="sr-only">件</span>
                  </span>
                )}
              </NavLink>
            </TooltipTrigger>
            {collapsed ? (
              <TooltipContent side="right">
                {badge === null ? screen.label : `${screen.label}(${badge}件)`}
              </TooltipContent>
            ) : null}
          </Tooltip>
        );
      })}
    </nav>
  );
}

/** 題名の2行。サイドバーの上端とドロワーの上端で共通に使う。 */
function BrandTitle() {
  return (
    <div className="min-w-0">
      <p className="truncate text-body leading-tight font-semibold tracking-tight">
        Factory Console
      </p>
      <p className="text-caption text-subtle">運用画面</p>
    </div>
  );
}

/**
 * 画面のメニュー。md以上は、4つの入口と件数を出す左のサイドバーで、たたむ操作は保存領域に残す。
 * md未満は、上部のバーのボタンからドロワーを開く。たたむ操作は無く、常に広げた形で出す。
 */
export function Sidebar() {
  const summary = useSummary();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const counts =
    summary.data === undefined ? undefined : actionableCounts(summary.data);
  const actionableTotal = SCREENS.reduce(
    (total, screen) => total + screen.badge(counts),
    0,
  );

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  const closeDrawer = (): void => {
    setDrawerOpen(false);
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground md:hidden">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          aria-label={menuButtonLabel(actionableTotal)}
          className="relative inline-flex size-9 min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors duration-(--duration-fast) ease-standard hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={() => {
            setDrawerOpen(true);
          }}
        >
          <Menu aria-hidden="true" className="size-5" />
          {formatBadgeCount(actionableTotal) === null ? null : (
            <span
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-primary ring-2 ring-sidebar"
            />
          )}
        </button>
        <BrandMark className="size-7" />
        <p className="truncate text-body font-semibold tracking-tight">
          Factory Console
        </p>
      </header>
      <NavDrawer open={drawerOpen} label="メニュー" onClose={closeDrawer}>
        <div className="flex h-14 shrink-0 items-center gap-3 px-4">
          <BrandMark />
          <BrandTitle />
          <button
            type="button"
            aria-label="メニューを閉じる"
            className="ml-auto inline-flex size-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-subtle outline-none transition-colors duration-(--duration-fast) ease-standard hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={closeDrawer}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <NavList collapsed={false} onNavigate={closeDrawer} />
        <div className="mt-auto flex flex-col gap-3 border-t border-sidebar-border px-4 py-3">
          <ReleaseInfo />
          <ThemeSwitch />
        </div>
      </NavDrawer>
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
          TRANSITION_WIDTH,
          collapsed ? "w-16" : "w-64",
        )}
      >
        <div
          className={cn(
            "flex h-16 items-center gap-3 px-4",
            collapsed && "justify-center px-0",
          )}
        >
          <BrandMark />
          {collapsed ? null : <BrandTitle />}
        </div>
        <NavList collapsed={collapsed} />
        <div
          className={cn(
            "mt-auto flex flex-col gap-3 border-t border-sidebar-border px-4 py-3",
            collapsed && "items-center px-0",
          )}
        >
          {collapsed ? null : (
            <>
              <ReleaseInfo />
              <ThemeSwitch />
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label="メニューの開閉"
                className="inline-flex size-8 items-center justify-center rounded-lg text-subtle outline-none transition-colors duration-(--duration-fast) ease-standard hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                onClick={toggle}
              >
                {collapsed ? (
                  <PanelLeftOpen aria-hidden="true" className="size-4" />
                ) : (
                  <PanelLeftClose aria-hidden="true" className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? "メニューを広げる" : "メニューをたたむ"}
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </>
  );
}
