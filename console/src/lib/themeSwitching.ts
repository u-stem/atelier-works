// テーマの切り替えの間だけ、全要素の遷移(transition)を止める。
// 遷移が残ると、`transition-colors`を持つ一部の要素だけが遅れて変わり、ちらついて見える。
// 切り替えの入口は`beginThemeSwitch`の1つで、ThemeSwitchの操作とOSの設定の変更の両方がこれを呼ぶ。
// 色の切り替えもJavaScriptが起こす。「OSに合わせる」のときも`data-theme`を常に付け、
// OSの設定の変更を受けたら、遷移を止めてから`data-theme`を替える。
// メディアクエリに色を任せると、変更のイベントが届く前に色の再計算が始まり、遷移を止められない。

import { useEffect } from "react";
import {
  parseThemePreference,
  resolveTheme,
  THEME_PREFERENCE_ATTRIBUTE,
} from "./theme.ts";

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

export type ThemeRoot = SwitchRoot & {
  getAttribute(name: string): string | null;
};

/**
 * OSの配色の設定が変わったとき、「OSに合わせる」ならdata-themeを替える。
 * 遷移を止めてから替える。明示した選択(ライトとダーク)は動かさない。
 * 選択を記録していないときは、theme-initが動かなかった場合なので、OSに合わせる。
 */
export function followColorSchemeChange(
  root: ThemeRoot,
  beginSwitch: () => void,
  prefersDark: boolean,
): void {
  const preference = parseThemePreference(
    root.getAttribute(THEME_PREFERENCE_ATTRIBUTE),
  );
  if (preference !== "system") {
    return;
  }
  beginSwitch();
  root.setAttribute("data-theme", resolveTheme(preference, prefersDark));
}

/**
 * OSの配色の設定が変わるたびに`onChange`を呼び、変わった後に暗いかどうかを渡す。
 * 戻り値の関数で購読をやめる。
 * Strict Modeの購読、解除、購読の順でも、リスナーが1つだけ残る。
 */
export function watchColorScheme(
  match: (query: string) => MediaQueryLike,
  onChange: (prefersDark: boolean) => void,
): () => void {
  const list = match(COLOR_SCHEME_QUERY);
  const listener = (): void => {
    onChange(list.matches);
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
 * 解除は2フレーム後に行う。
 */
export function beginThemeSwitch(): void {
  documentGuard ??= createThemeSwitchGuard(
    document.documentElement,
    afterTwoFrames,
  );
  documentGuard.begin();
}

/**
 * OSの設定が変わったら、「OSに合わせる」のときだけ、遷移を止めてdata-themeを替える。外枠に1つだけ置く。
 * ThemeSwitchは広い画面のサイドバーと狭い画面のドロワーの2か所に描かれるので、購読はそれぞれに置かない。
 */
export function useColorSchemeSwitchGuard(): void {
  useEffect(
    () =>
      watchColorScheme(
        (query) => window.matchMedia(query),
        (prefersDark) => {
          followColorSchemeChange(
            document.documentElement,
            beginThemeSwitch,
            prefersDark,
          );
        },
      ),
    [],
  );
}
