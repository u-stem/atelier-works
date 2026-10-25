import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import { SELECTED_STYLE } from "../lib/selectedStyle.ts";
import {
  parseThemePreference,
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../lib/theme.ts";
import { beginThemeSwitch } from "../lib/themeSwitching.ts";

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

/**
 * 選択をhtmlのdata-themeに反映し、保存領域に残す。
 * 替える直前に遷移を止め、一部の要素だけが遅れて変わるのを防ぐ。
 * 保存できない環境(プライベートブラウズなど)でも、表示の切り替えは行う。
 */
export function applyThemePreference(
  preference: ThemePreference,
  env: ThemeEnv,
): void {
  env.beginSwitch();
  if (preference === "system") {
    env.root.removeAttribute("data-theme");
  } else {
    env.root.setAttribute("data-theme", preference);
  }
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
    root: document.documentElement,
    storage,
  };
}

/** テーマの選択肢のボタンのクラス。選択中は、他の切り替えと同じ表し方にする。 */
export function themeOptionClass(pressed: boolean): string {
  return cn(
    "inline-flex size-7 items-center justify-center rounded-md border border-transparent text-subtle outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted motion-reduce:transition-none",
    pressed && SELECTED_STYLE,
  );
}

/** ライト、ダーク、OSに合わせるの3つを、アイコンの切り替えで選ぶ。 */
export function ThemeSwitch() {
  const [preference, setPreference] =
    useState<ThemePreference>(readStoredPreference);
  return (
    <fieldset className="m-0 inline-flex w-fit min-w-0 gap-0.5 rounded-lg border-0 bg-muted p-0.5">
      <legend className="sr-only">テーマ</legend>
      {THEME_OPTIONS.map((option) => {
        const Icon = ICONS[option.value];
        const pressed = preference === option.value;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={pressed}
                aria-label={option.label}
                className={themeOptionClass(pressed)}
                onClick={() => {
                  applyThemePreference(option.value, browserEnv());
                  setPreference(option.value);
                }}
              >
                <Icon aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
