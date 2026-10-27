import { type ReactNode, useCallback, useState } from "react";
import { Outlet } from "react-router";
import { cn } from "../lib/cn.ts";
import { APP_MAIN_CLASS } from "../lib/layoutClasses.ts";
import { MAIN_ID, PAGE_HEADING_ID } from "../lib/routeFocus.ts";
import { ReloadBanner } from "../ReloadBanner.tsx";
import { useReleaseWatch } from "../useReleaseWatch.ts";
import { AuthBanner } from "./AuthBanner.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { OfflineBanner } from "./OfflineBanner.tsx";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { SkipLink } from "./SkipLink.tsx";
import {
  useBrowserPlatform,
  useKeyboardShortcuts,
  useShortcutsEnabled,
} from "./useKeyboardShortcuts.ts";
import { usePageName, usePageTitle } from "./usePageTitle.ts";
import { useRouteFocus } from "./useRouteFocus.ts";

/**
 * 画面を出す本文の領域。
 * 見出しが無い画面でも、遷移後のフォーカスと本文へのスキップの移し先になるよう、プログラムからだけフォーカスできる。
 * 領域全体にフォーカスの輪は描かない。輪が出ると、画面の中の操作の輪と紛れる。
 * 名前は見出し(h1)から取る。見出しが無い画面では、`aria-labelledby`の参照先が無いので、画面の名前(`aria-label`)を使う。
 * 「メイン、作業項目」と「見出し1、作業項目」のように、同じ名前を別の名前で重ねて読ませないためである。
 */
export function AppMain({
  name,
  children,
}: {
  name: string | null;
  children: ReactNode;
}) {
  return (
    <main
      id={MAIN_ID}
      tabIndex={-1}
      aria-labelledby={PAGE_HEADING_ID}
      {...(name === null ? {} : { "aria-label": name })}
      className={cn(APP_MAIN_CLASS, "outline-none")}
    >
      {children}
    </main>
  );
}

/**
 * 全画面に共通の外枠。上に帯(版の更新、ログイン切れ、Windmillに届かないとき)、残りに画面を出す。
 * メニューは、md以上では画面の左、md未満では画面の上に置く。
 * 画面の遷移のたびに、タブの題を画面の名前にし、フォーカスを見出しへ移す。
 * コマンドパレットとショートカットの一覧(ヘルプ)は、ここで開閉を持つ。
 * 開くキーは`useKeyboardShortcuts`が受け、サイドバーのボタンとパレットの項目からもヘルプを開ける。
 */
export function AppShell() {
  const releaseNotice = useReleaseWatch();
  const name = usePageName();
  usePageTitle(name);
  useRouteFocus();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsEnabled, setShortcutsEnabled] = useShortcutsEnabled();
  const platform = useBrowserPlatform();
  const togglePalette = useCallback(() => {
    setPaletteOpen((current) => !current);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);
  const openHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);
  useKeyboardShortcuts({
    enabled: shortcutsEnabled,
    onTogglePalette: togglePalette,
    onOpenHelp: openHelp,
  });

  return (
    <div className="flex h-dvh flex-col">
      <SkipLink />
      <ReloadBanner notice={releaseNotice} />
      <AuthBanner />
      <OfflineBanner />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Sidebar onOpenHelp={openHelp} />
        <AppMain name={name}>
          <Outlet />
        </AppMain>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenHelp={openHelp}
      />
      <ShortcutHelp
        open={helpOpen}
        onClose={closeHelp}
        enabled={shortcutsEnabled}
        onEnabledChange={setShortcutsEnabled}
        platform={platform}
      />
    </div>
  );
}
