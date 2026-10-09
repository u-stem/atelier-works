import { ExternalLink, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { NavLink } from "react-router";
import { useSummary } from "../api/queries.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import {
  formatBadgeCount,
  navLinkClass,
  nextNavFocusIndex,
  parseSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
} from "../lib/navigation.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { SCREENS } from "./screens.ts";

/** 切り替えまでの間は、Windmillのraw appの旧Consoleへ案内する。 */
const LEGACY_CONSOLE_PATH = "/apps/get/f/factory/factory_console";

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
        "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width]",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {collapsed ? null : (
          <span className="truncate px-1 font-semibold">Factory Console</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-expanded={!collapsed}
          aria-label="メニューの開閉"
          onClick={toggle}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </Button>
      </div>
      <nav
        ref={navRef}
        aria-label="メインメニュー"
        className="flex flex-1 flex-col gap-1 px-2"
        onKeyDown={handleKeyDown}
      >
        {SCREENS.map((screen) => {
          const Icon = screen.icon;
          const badge = formatBadgeCount(screen.badge(summary.data?.counts));
          return (
            <Tooltip key={screen.id}>
              <TooltipTrigger asChild>
                <NavLink
                  to={screen.path}
                  end={screen.path === "/"}
                  className={navLinkClass(collapsed)}
                >
                  <span className="relative inline-flex shrink-0">
                    <Icon aria-hidden="true" className="size-4" />
                    {collapsed && badge !== null ? (
                      <span
                        aria-hidden="true"
                        className="absolute -top-2 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-medium text-primary-foreground"
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
                    <Badge
                      variant="secondary"
                      className={cn(collapsed && "sr-only")}
                    >
                      {badge}
                      <span className="sr-only">件</span>
                    </Badge>
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
      {collapsed ? null : (
        <div className="flex flex-col items-start gap-2 border-t border-sidebar-border px-4 py-3">
          <ThemeToggle />
          <a
            className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            href={LEGACY_CONSOLE_PATH}
          >
            旧Consoleを開く
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </div>
      )}
    </aside>
  );
}
