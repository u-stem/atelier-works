import { ExternalLink, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
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
import {
  formatBadgeCount,
  navLinkClass,
  nextNavFocusIndex,
  parseSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
} from "../lib/navigation.ts";
import { LEGACY_CONSOLE_PATH } from "./legacyConsole.ts";
import { SCREENS } from "./screens.ts";
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
 * 4つの入口と件数を出す左のメニュー。たたむ操作は保存領域に残す。
 * 入口の間は、上下の矢印とHome・Endで移れる。
 */
export function Sidebar() {
  const summary = useSummary();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const navRef = useRef<HTMLElement>(null);

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

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 motion-reduce:transition-none",
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
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-body leading-tight font-semibold tracking-tight">
              Factory Console
            </p>
            <p className="text-caption text-subtle">運用画面</p>
          </div>
        )}
      </div>
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
                  <span
                    className={cn("flex-1 truncate", collapsed && "sr-only")}
                  >
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
                  {badge === null
                    ? screen.label
                    : `${screen.label}(${badge}件)`}
                </TooltipContent>
              ) : null}
            </Tooltip>
          );
        })}
      </nav>
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
            <a
              className="inline-flex w-fit items-center gap-1 rounded-sm text-small text-subtle underline underline-offset-4 outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transition-none"
              href={LEGACY_CONSOLE_PATH}
              target="_blank"
              rel="noopener noreferrer"
            >
              旧Consoleを開く
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label="メニューの開閉"
              className="inline-flex size-8 items-center justify-center rounded-lg text-subtle outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transition-none"
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
  );
}
