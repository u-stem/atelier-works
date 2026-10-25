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
