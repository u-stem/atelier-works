import { useState } from "react";
import {
  nextThemePreference,
  parseThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
  themePreferenceLabel,
} from "./lib/theme.ts";

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * 選択をhtmlのdata-themeに反映し、保存領域に残す。
 * 保存できない環境(プライベートブラウズなど)でも、表示の切り替えは行う。
 */
function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.dataset.theme = preference;
  }
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // 保存できなくても、この画面の表示はすでに切り替わっている。
  }
}

export function ThemeToggle() {
  const [preference, setPreference] =
    useState<ThemePreference>(readStoredPreference);
  return (
    <button
      type="button"
      className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={() => {
        const next = nextThemePreference(preference);
        applyPreference(next);
        setPreference(next);
      }}
    >
      テーマ: {themePreferenceLabel(preference)}
    </button>
  );
}
