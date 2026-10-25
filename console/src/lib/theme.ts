// テーマの選択(OSに合わせる・ライト・ダーク)を扱う純粋関数。
// DOMと保存領域には触れない。public/assets/theme-init-*.jsも同じキーと値を読む。

export const THEME_STORAGE_KEY = "factory-console.theme";

export type ThemePreference = "system" | "light" | "dark";

const LABELS: Readonly<Record<ThemePreference, string>> = {
  system: "OSに合わせる",
  light: "ライト",
  dark: "ダーク",
};

/** 切り替えに並べる選択。ライト、ダーク、OSに合わせるの順。 */
export const THEME_OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
}[] = [
  { value: "light", label: LABELS.light },
  { value: "dark", label: LABELS.dark },
  { value: "system", label: LABELS.system },
];

/**
 * 保存領域から読んだ値をテーマの選択にする。
 * 知らない値や読めなかった値(`null`)は、OSの設定に従う`system`にする。
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** 画面に出す選択の名前を返す。 */
export function themePreferenceLabel(preference: ThemePreference): string {
  return LABELS[preference];
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
