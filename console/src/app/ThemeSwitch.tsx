import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import { SIDEBAR_ICON_BUTTON_CLASS } from "../lib/controlClasses.ts";
import {
  currentTheme,
  oppositeTheme,
  resolveTheme,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../lib/theme.ts";
import { beginThemeSwitch, COLOR_SCHEME_QUERY } from "../lib/themeSwitching.ts";

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

/** いま画面に付いている配色を、htmlの`data-theme`とOSの設定から読む。 */
function readCurrentTheme(): "light" | "dark" {
  return currentTheme(
    document.documentElement.getAttribute("data-theme"),
    () => window.matchMedia(COLOR_SCHEME_QUERY).matches,
  );
}

/** 配色は、この切り替え以外にも、OSの設定の変更で替わる。属性の変化を見て、表示を合わせる。 */
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    observer.disconnect();
  };
}

/**
 * ライトとダークを、1つのボタンで入れ替える。
 * アイコンと名前は、押したときに付く配色を示す(ライトの画面では月、ダークの画面では太陽)。
 * 押すと明示の選択になり、「OSに合わせる」は外れる。
 * たたんだサイドバーでは、名前を読み上げ専用にして、アイコンだけを見せる。
 */
export function ThemeSwitch({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    readCurrentTheme,
    (): "light" | "dark" => "light",
  );
  const next = oppositeTheme(theme);
  const label = next === "dark" ? "ダークにする" : "ライトにする";
  const Icon = next === "dark" ? Moon : Sun;
  const button = (
    <button
      type="button"
      className={cn(
        SIDEBAR_ICON_BUTTON_CLASS,
        compact
          ? "size-8 text-subtle"
          : "h-8 w-full justify-start gap-2 px-2 text-small text-subtle",
        className,
      )}
      onClick={() => {
        applyThemePreference(next, browserEnv());
      }}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </button>
  );
  if (!compact) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
