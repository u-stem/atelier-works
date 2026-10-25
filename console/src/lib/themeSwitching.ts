// テーマの切り替えの間だけ、全要素の遷移(transition)を止める。

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
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

export function createThemeSwitchGuard(
  _root: SwitchRoot,
  _schedule: Scheduler,
): { begin(): void } {
  return { begin: () => undefined };
}

export function watchColorScheme(
  _match: (query: string) => MediaQueryLike,
  _onChange: () => void,
): () => void {
  return () => undefined;
}

export function beginThemeSwitch(): void {}
