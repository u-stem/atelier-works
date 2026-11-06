// テーマの選択(OSに合わせる・ライト・ダーク)を扱う純粋関数。
// DOMと保存領域には触れない。public/assets/theme-init-*.jsも同じキーと値を読む。

export const THEME_STORAGE_KEY = "factory-console.theme";

export type ThemePreference = "system" | "light" | "dark";

/** 切り替えボタンが次に付ける配色。いまの配色の反対を返す。 */
export function oppositeTheme(theme: "light" | "dark"): "light" | "dark" {
  return theme === "dark" ? "light" : "dark";
}

/**
 * 画面にいま付いている配色を返す。
 * `data-theme`が`light`か`dark`ならそれを使う。
 * 無いとき(OSの設定を読めない環境など)は、OSの設定に従う。OSの設定を読む関数が例外を投げたときは`light`にする。
 */
export function currentTheme(
  attribute: string | null,
  prefersDark: () => boolean,
): "light" | "dark" {
  if (attribute === "light" || attribute === "dark") {
    return attribute;
  }
  try {
    return prefersDark() ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * 保存領域から読んだ値をテーマの選択にする。
 * 知らない値や読めなかった値(`null`)は、OSの設定に従う`system`にする。
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * 選択をhtmlに写すときの属性。値は`system`、`light`、`dark`のどれか。
 * 実際の配色は`data-theme`が決め、OSに合わせている間も`light`か`dark`を付ける。
 * OSの設定の変更を受けたときに、この属性で「OSに合わせる」かを見分ける。
 */
export const THEME_PREFERENCE_ATTRIBUTE = "data-theme-preference";

/**
 * 選択から、実際に付けるdata-themeの値を決める。
 * 「OSに合わせる」は、OSの配色の設定をここで解決する。
 * メディアクエリに色を任せると、OSの設定が変わったとき、遷移を止めるより先に色が替わり始める。
 */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): "light" | "dark" {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}
