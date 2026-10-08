// テーマの選択(OSに合わせる・ライト・ダーク)を扱う純粋関数。
// DOMと保存領域には触れない。public/assets/theme-init-*.jsも同じキーと値を読む。

export const THEME_STORAGE_KEY = "factory-console.theme";

export type ThemePreference = "system" | "light" | "dark";

const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

const LABELS: Readonly<Record<ThemePreference, string>> = {
  system: "OSに合わせる",
  light: "ライト",
  dark: "ダーク",
};

/**
 * 保存領域から読んだ値をテーマの選択にする。
 * 知らない値や読めなかった値(`null`)は、OSの設定に従う`system`にする。
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** ボタンを押したときの次の選択を返す。system → light → dark → systemの順に回る。 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? "system";
}

/** 画面に出す選択の名前を返す。 */
export function themePreferenceLabel(preference: ThemePreference): string {
  return LABELS[preference];
}
