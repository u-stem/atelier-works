// テーマの切り替えの間だけ、全要素の遷移(transition)を止める。
// 遷移が残ると、`transition-colors`を持つ一部の要素だけが遅れて変わり、ちらついて見える。
// 切り替えの入口は`beginThemeSwitch`の1つで、ThemeSwitchの操作とOSの設定の変更の両方がこれを呼ぶ。

import { useEffect } from "react";

/** 切り替えの間だけhtmlに付ける属性。index.cssが、この属性の下で遷移を止める。 */
export const THEME_SWITCHING_ATTRIBUTE = "data-theme-switching";

/** OSの配色の設定を表すメディアクエリ。 */
export const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export type SwitchRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/** `callback`を描画の後に遅らせて呼ぶ。戻り値の関数で取り消す。 */
export type Scheduler = (callback: () => void) => () => void;

export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

/**
 * 切り替えの間の印を管理する。`begin`のたびに番号を進め、解除は最後の番号のものだけが行う。
 * 続けて切り替えたときに、先の解除が後の切り替えの途中で印を外さないためである。
 */
export function createThemeSwitchGuard(
  root: SwitchRoot,
  schedule: Scheduler,
): { begin(): void } {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      const token = latest;
      root.setAttribute(THEME_SWITCHING_ATTRIBUTE, "");
      schedule(() => {
        if (token === latest) {
          root.removeAttribute(THEME_SWITCHING_ATTRIBUTE);
        }
      });
    },
  };
}

/**
 * OSの配色の設定が変わるたびに`onChange`を呼ぶ。戻り値の関数で購読をやめる。
 * Strict Modeの購読、解除、購読の順でも、リスナーが1つだけ残る。
 */
export type ThemeRoot = SwitchRoot & {
  getAttribute(name: string): string | null;
};

export function followColorSchemeChange(
  _root: ThemeRoot,
  _beginSwitch: () => void,
  _prefersDark: boolean,
): void {}

export function watchColorScheme(
  match: (query: string) => MediaQueryLike,
  onChange: (prefersDark: boolean) => void,
): () => void {
  const list = match(COLOR_SCHEME_QUERY);
  const listener = (): void => {
    onChange(false);
  };
  list.addEventListener("change", listener);
  return () => {
    list.removeEventListener("change", listener);
  };
}

/**
 * 2フレーム後に呼ぶ。印を付けたのと同じフレームで、スタイルの再計算が終わっているようにする。
 * 背景のタブではフレームが進まず、印は表示に戻るまで残る。残っても遷移が止まるだけである。
 */
function afterTwoFrames(callback: () => void): () => void {
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(outer);
    cancelAnimationFrame(inner);
  };
}

let documentGuard: { begin(): void } | null = null;

/**
 * 画面全体の遷移を止めて、テーマの切り替えを始める。切り替えの直前に呼ぶ。
 * OSの設定の変更が、スタイルの再計算より後に届く環境では、この呼び出しが間に合わない。
 * そのときは、OSの設定をJavaScriptで解決して`data-theme`を常に付ける形に替える。入口はここだけである。
 */
export function beginThemeSwitch(): void {
  documentGuard ??= createThemeSwitchGuard(
    document.documentElement,
    afterTwoFrames,
  );
  documentGuard.begin();
}

/**
 * OSの設定の変更で、遷移を止める。外枠に1つだけ置く。
 * ThemeSwitchは広い画面のサイドバーと狭い画面のドロワーの2か所に描かれるので、購読はそれぞれに置かない。
 */
export function useColorSchemeSwitchGuard(): void {
  useEffect(
    () =>
      watchColorScheme((query) => window.matchMedia(query), beginThemeSwitch),
    [],
  );
}
