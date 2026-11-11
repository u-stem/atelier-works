// axe-coreの検査が見る規則のタグと、検査するテーマ。
// 画面の検査(`axe.a11y.ts`)と書き込みの検査(`writes.e2e.ts`)が、同じ範囲で測るために共有する。

import type { Theme } from "./support.ts";

/** WCAG 2.0と2.1の、AとAAの規則。 */
export const WCAG_TAGS: readonly string[] = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
];

export const THEMES: readonly Theme[] = ["light", "dark"];
