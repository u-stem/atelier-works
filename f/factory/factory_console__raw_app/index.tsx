import React from "react";

import { createRoot } from "react-dom/client";
import App from "./App";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "factory-console.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // `localStorage`が使えない環境(プライベートモードなど)では、ヒント無しとして扱う。
    return null;
  }
}

function readParentFrameHint(): Theme | null {
  try {
    const parentDocument = window.parent?.document;
    if (parentDocument === undefined || parentDocument === document) {
      return null;
    }
    return parentDocument.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  } catch {
    // 別オリジンなどでアクセスできない場合は、ヒント無しとして扱う。
    return null;
  }
}

function readSystemPreference(): Theme {
  if (typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * 最初のテーマを`<html>`の`data-theme`に適用する。最初の描画の前に呼び、
 * テーマの切り替えや保存済みの設定での再読み込みのとき、Reactのマウント中に
 * 逆のテーマが一瞬見えないようにする。`App.tsx`はこの属性を初期状態として読む。
 */
function applyInitialTheme(): void {
  const theme =
    readStoredTheme() ?? readParentFrameHint() ?? readSystemPreference();
  document.documentElement.setAttribute("data-theme", theme);
}

applyInitialTheme();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("factory_console: #root element not found");
}

const root = createRoot(rootElement);
root.render(<App />);
