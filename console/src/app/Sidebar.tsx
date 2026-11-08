import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Keyboard,
  Menu,
  X,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  describeRelease,
  type ReleaseDescription,
} from "../lib/consoleStatus.ts";
import { SIDEBAR_ICON_BUTTON_CLASS } from "../lib/controlClasses.ts";
import { actionableCounts } from "../lib/inboxView.ts";
import { TRANSITION_WIDTH } from "../lib/motionClasses.ts";
import {
  edgeToggleFollows,
  edgeToggleOffset,
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

/** WindmillのUIの入口。Consoleと同じオリジンのルートである。 */
export const WINDMILL_URL = "/";

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

/** 配信している版と確認の時刻の文。識別子のSHAだけを等幅で出し、「版」の語は本文の書体にする。 */
export function ReleaseNote({ release }: { release: ReleaseDescription }) {
  return (
    <p className="text-caption leading-5 text-subtle">
      {release.versionSha === null ? null : (
        <span className="font-medium text-muted-foreground tabular-nums">
          版 <span className="font-mono">{release.versionSha}</span>
        </span>
      )}
      {release.versionSha === null ? null : "・"}
      <span className="tabular-nums">{release.checkedLabel}</span>
      {release.warning === null ? null : (
        <span className="mt-1 block font-medium text-notice">
          {release.warning}
        </span>
      )}
    </p>
  );
}

/** 配信している版と、取り込みの最後の確認。取れた情報だけを出し、取れなければ何も出さない。 */
function ReleaseInfo() {
  const status = useConsoleStatus();
  const now = useNow();
  const release = status === null ? null : describeRelease(status, now);
  return release === null ? null : <ReleaseNote release={release} />;
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
        const readCount = screen.badge(
          summary.data === undefined
            ? undefined
            : actionableCounts(summary.data),
        );
        // 要対応の件数を持つ画面は、行き先の件数を持たない。どちらか0より大きいほうを出す。
        const badge = formatBadgeCount(
          readCount > 0
            ? readCount
            : (screen.destinationBadge?.(summary.data) ?? 0),
        );
        const link = (
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
                  className="absolute -top-2 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-caption leading-4 font-semibold text-primary-foreground tabular-nums"
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
        );
        // ツールチップは、たたんだ形でだけ描く。広げた形で中身の無いツールチップを持つと、
        // ポインタが外れても閉じる処理が働かず、「開いた」状態が残って、たたんだ瞬間にすべて見えるためである。
        if (!collapsed) {
          return <Fragment key={screen.id}>{link}</Fragment>;
        }
        return (
          <Tooltip key={screen.id}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">
              {badge === null ? screen.label : `${screen.label}(${badge}件)`}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/**
 * ショートカットの一覧を開くボタン。
 * 1文字のショートカットを無効にしても一覧を開けて、有効に戻せるようにするための入口である。
 * たたんだサイドバーでは、名前を読み上げ専用にして、アイコンだけを見せる。
 */
function ShortcutHelpButton({
  compact,
  className,
  onClick,
}: {
  compact: boolean;
  className?: string;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      aria-haspopup="dialog"
      className={cn(
        SIDEBAR_ICON_BUTTON_CLASS,
        compact
          ? "size-8 text-subtle"
          : "h-8 w-full justify-start gap-2 px-2 text-small text-subtle",
        className,
      )}
      onClick={onClick}
    >
      <Keyboard aria-hidden="true" className="size-4 shrink-0" />
      <span className={compact ? "sr-only" : undefined}>ショートカット</span>
    </button>
  );
  if (!compact) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">ショートカット</TooltipContent>
    </Tooltip>
  );
}

/**
 * WindmillのUIへのリンク。WindmillはConsoleと同じオリジンの`/`で配信される。
 * WindmillのUIはログインが要り、Consoleの作業を止めないよう、別のタブで開く。
 * たたんだサイドバーでは、名前を読み上げ専用にして、アイコンだけを見せる。
 */
function WindmillLink({
  compact,
  className,
}: {
  compact: boolean;
  className?: string;
}) {
  const link = (
    <a
      href={WINDMILL_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        SIDEBAR_ICON_BUTTON_CLASS,
        compact
          ? "size-8 text-subtle"
          : "h-8 w-full justify-start gap-2 px-2 text-small text-subtle",
        className,
      )}
    >
      <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
      <span className={compact ? "sr-only" : undefined}>
        Windmill
        <span className="sr-only">(新しいタブで開く)</span>
      </span>
    </a>
  );
  if (!compact) {
    return link;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">Windmill(新しいタブ)</TooltipContent>
    </Tooltip>
  );
}

/**
 * サイドバーの右の縁にかぶせる、開閉のつまみ。
 * 縁にポインタを重ねると、縁の線が色づき、ポインタを当てた高さに丸いボタンが出る。ポインタを動かすと、ボタンも縁に沿って追う(タッチでは追わない)。
 * 位置はCSSでも縁の内側に挟むので、縁が縮んでもボタンは画面の外に残らない。
 * ボタンの名前は、ツールチップでなくネイティブの`title`で出す。ツールチップは、名前の上にポインタを置くと開いたままになり、ボタンが消えても名前だけが残るためである。
 * キーボードでは常に順番に入り、フォーカス中は見える。
 * フォーカスで出すときは遷移を止める。遷移の最初の1フレームは不透明度が0のままで、Tabで止まった直後に見えない要素と読まれるためである。
 * ポインタを重ねられない端末(`hover: none`)では、ボタンを常に見せる。
 * 縁の線は、ホバーできる端末では、ボタンと同じ条件(ホバーとキーボードのフォーカス)で出す。マウスで押した後にボタンだけ消えて線が残るのを避けるためである。
 */
function EdgeToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Icon = collapsed ? ChevronRight : ChevronLeft;
  const edgeRef = useRef<HTMLDivElement>(null);

  // つまみを、ポインタを当てた高さへ寄せる。位置は再描画せず、CSSの変数で渡す。
  const followPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const edge = edgeRef.current;
    if (edge === null || !edgeToggleFollows(event.pointerType)) {
      return;
    }
    const rect = edge.getBoundingClientRect();
    edge.style.setProperty(
      "--edge-y",
      `${edgeToggleOffset(event.clientY, rect.top, rect.height)}px`,
    );
  };

  return (
    <div
      ref={edgeRef}
      className="group/edge absolute inset-y-0 -right-1.5 z-20 w-3"
      onPointerMove={followPointer}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary opacity-0 transition-opacity duration-(--duration-fast) ease-standard group-has-[:focus-visible]/edge:opacity-60 group-has-[:focus-visible]/edge:transition-none group-hover/edge:opacity-60"
      />
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label="メニューの開閉"
        title={collapsed ? "メニューを広げる" : "メニューをたたむ"}
        className="absolute top-[clamp(1rem,var(--edge-y,50%),calc(100%_-_1rem))] left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-subtle opacity-0 outline-none transition-opacity duration-(--duration-fast) ease-standard group-hover/edge:opacity-100 [@media(hover:none)]:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:transition-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={onToggle}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    </div>
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
 * 画面のメニュー。md以上は、4つの入口と件数を出す左のサイドバーで、たたむ操作は縁のつまみで行い、状態を保存領域に残す。
 * md未満は、上部のバーのボタンからドロワーを開く。たたむ操作は無く、常に広げた形で出す。
 * `onOpenHelp`は、ショートカットの一覧を開く。ドロワーから開くときは、ドロワーを閉じてから呼ぶ。
 */
export function Sidebar({ onOpenHelp }: { onOpenHelp: () => void }) {
  const summary = useSummary();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const counts =
    summary.data === undefined ? undefined : actionableCounts(summary.data);
  // 合計は`badge`だけを足す。行き先の件数(`destinationBadge`)は同じ通知を数えているので足さない。
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
          className={cn(
            SIDEBAR_ICON_BUTTON_CLASS,
            "relative size-9 min-h-11 min-w-11 text-muted-foreground",
          )}
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
            className={cn(
              SIDEBAR_ICON_BUTTON_CLASS,
              "ml-auto size-8 min-h-11 min-w-11 shrink-0 text-subtle",
            )}
            onClick={closeDrawer}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <NavList collapsed={false} onNavigate={closeDrawer} />
        <div className="mt-auto flex flex-col gap-3 border-t border-sidebar-border px-4 py-3">
          <ReleaseInfo />
          <ThemeSwitch className="min-h-11" />
          <ShortcutHelpButton
            compact={false}
            className="min-h-11"
            onClick={() => {
              closeDrawer();
              onOpenHelp();
            }}
          />
          <WindmillLink compact={false} className="min-h-11" />
        </div>
      </NavDrawer>
      <aside
        className={cn(
          "relative hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
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
          {collapsed ? null : <ReleaseInfo />}
          <ThemeSwitch compact={collapsed} />
          <ShortcutHelpButton compact={collapsed} onClick={onOpenHelp} />
          <WindmillLink compact={collapsed} />
        </div>
        <EdgeToggle collapsed={collapsed} onToggle={toggle} />
      </aside>
    </>
  );
}
