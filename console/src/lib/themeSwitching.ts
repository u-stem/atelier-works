// テーマの切り替えの間だけ、全要素の遷移を止める。

export const THEME_SWITCHING_ATTRIBUTE = "";

export const COLOR_SCHEME_QUERY = "";

export type SwitchRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export type Scheduler = (callback: () => void) => () => void;

export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

export function createThemeSwitchGuard(
  _root: SwitchRoot,
  _schedule: Scheduler,
): { begin(): void } {
  return { begin: () => undefined };
}

export type ThemeRoot = SwitchRoot & {
  getAttribute(name: string): string | null;
};

export function followColorSchemeChange(
  _root: ThemeRoot,
  _beginSwitch: () => void,
  _prefersDark: boolean,
): void {}

export function watchColorScheme(
  _match: (query: string) => MediaQueryLike,
  _onChange: (prefersDark: boolean) => void,
): () => void {
  return () => undefined;
}

export type ColorSchemeEnv = {
  match(query: string): MediaQueryLike;
  root: ThemeRoot;
  beginSwitch(): void;
};

export function followColorScheme(_env: ColorSchemeEnv): () => void {
  return () => undefined;
}

export function beginThemeSwitch(): void {}

export function useColorSchemeSwitchGuard(): void {}
