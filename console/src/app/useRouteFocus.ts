// 画面の遷移の後に、フォーカスを新しい画面の見出しへ移す。判定と手順は`lib/routeFocus.ts`にある。

import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import {
  type FocusEnv,
  MAIN_ID,
  moveFocusAfterNavigation,
  PAGE_HEADING_ID,
  shouldMoveFocus,
} from "../lib/routeFocus.ts";

/** メニューのドロワーの`<dialog>`を見つける。`NavDrawer`が付ける`data-nav-drawer`で選ぶ。 */
const OPEN_NAV_DRAWER = "dialog[data-nav-drawer][open]";

const BROWSER_ENV: FocusEnv = {
  heading: () => document.getElementById(PAGE_HEADING_ID),
  main: () => document.getElementById(MAIN_ID),
  openNavDrawer: () => {
    const dialog = document.querySelector(OPEN_NAV_DRAWER);
    if (dialog === null) {
      return null;
    }
    return {
      onceClosed: (callback) => {
        dialog.addEventListener("close", callback, { once: true });
        return () => {
          dialog.removeEventListener("close", callback);
        };
      },
    };
  },
};

/**
 * `pathname`が変わったとき、フォーカスを見出しへ移す。外枠に1つだけ置く。
 * `search`だけが変わる操作(タブ、選択、絞り込み)と、最初の表示では移さない。
 * 画面が自分で行うフォーカスの移動(要対応の一覧と詳細の切り替え)は、`search`の変更で起きるので、妨げない。
 */
export function useRouteFocus(): void {
  const { pathname } = useLocation();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = pathname;
    if (!shouldMoveFocus(before, pathname)) {
      return undefined;
    }
    return moveFocusAfterNavigation(BROWSER_ENV);
  }, [pathname]);
}
