import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { ToggleChip, ToggleChipGroup } from "../components/ToggleChip.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import {
  parseThemePreference,
  resolveTheme,
  THEME_OPTIONS,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../lib/theme.ts";
import { beginThemeSwitch, COLOR_SCHEME_QUERY } from "../lib/themeSwitching.ts";

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export type ThemeEnv = {
  /** 全要素の遷移を止める。テーマを替える直前に呼ぶ。 */
  beginSwitch(): void;
  /** OSの配色の設定が暗いか。 */
  prefersDark(): boolean;
  root: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  /** 保存領域。使えない環境では`null`。 */
  storage: {
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  } | null;
};

/** 付けるdata-themeの値を返す。「OSに合わせる」でOSの設定を読めないときは`null`。 */
function resolveForRoot(
  preference: ThemePreference,
  env: ThemeEnv,
): "light" | "dark" | null {
  if (preference !== "system") {
    return resolveTheme(preference, false);
  }
  try {
    return resolveTheme(preference, env.prefersDark());
  } catch {
    return null;
  }
}

/**
 * 選択をhtmlのdata-themeに反映し、保存領域に残す。
 * 「OSに合わせる」のときも、OSの設定を解決してdata-themeを付ける。保存するのは選択(system、light、dark)で、解決した配色は保存しない。
 * 替える直前に遷移を止め、一部の要素だけが遅れて変わるのを防ぐ。
 * 保存できない環境(プライベートブラウズなど)でも、表示の切り替えは行う。
 * OSの設定を読むのは「OSに合わせる」のときだけで、読めなければdata-themeを外し、スタイルシートの既定に任せる。
 * 明示した選択は、OSの設定を読めなくても切り替わり、保存される。
 */
export function applyThemePreference(
  preference: ThemePreference,
  env: ThemeEnv,
): void {
  env.beginSwitch();
  const theme = resolveForRoot(preference, env);
  if (theme === null) {
    env.root.removeAttribute("data-theme");
  } else {
    env.root.setAttribute("data-theme", theme);
  }
  env.root.setAttribute(THEME_PREFERENCE_ATTRIBUTE, preference);
  try {
    if (preference === "system") {
      env.storage?.removeItem(THEME_STORAGE_KEY);
    } else {
      env.storage?.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // 保存できなくても、この画面の表示はすでに切り替わっている。
  }
}

function browserEnv(): ThemeEnv {
  let storage: ThemeEnv["storage"] = null;
  try {
    storage = window.localStorage;
  } catch {
    // 保存領域に触れない環境では、保存せずに切り替える。
  }
  return {
    beginSwitch: beginThemeSwitch,
    prefersDark: () => window.matchMedia(COLOR_SCHEME_QUERY).matches,
    root: document.documentElement,
    storage,
  };
}

/** ライト、ダーク、OSに合わせるの3つを、アイコンの切り替えで選ぶ。 */
export function ThemeSwitch() {
  const [preference, setPreference] =
    useState<ThemePreference>(readStoredPreference);
  return (
    <ToggleChipGroup legend="テーマ">
      {THEME_OPTIONS.map((option) => {
        const Icon = ICONS[option.value];
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <ToggleChip
                pressed={preference === option.value}
                aria-label={option.label}
                className="size-7 justify-center text-subtle"
                onClick={() => {
                  applyThemePreference(option.value, browserEnv());
                  setPreference(option.value);
                }}
              >
                <Icon aria-hidden="true" className="size-4" />
              </ToggleChip>
            </TooltipTrigger>
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleChipGroup>
  );
}
