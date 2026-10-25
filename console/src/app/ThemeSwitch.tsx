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

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

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

export type ThemeEnv = {
  beginSwitch(): void;
  root: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  storage: {
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  } | null;
};

export function applyThemePreference(
  _preference: ThemePreference,
  _env: ThemeEnv,
): void {}

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
                  applyPreference(option.value);
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
