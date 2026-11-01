// 画面とダイアログを、axe-coreで検査する。WCAG 2.0と2.1のAとAAの規則だけを見る。
// 検査は、ビルド済みのConsoleを、テーマ(ライト、ダーク)と、データの有る無しの組み合わせで開いて行う。
// 規則の無効化、検査の対象からの除外、既知の違反の許容リストは持たない。

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  expect,
  type Mode,
  openScreen,
  settle,
  type Theme,
  test,
} from "./support.ts";

const WCAG_TAGS: readonly string[] = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
];

const THEMES: readonly Theme[] = ["light", "dark"];
const MODES: readonly Mode[] = ["normal", "empty"];

/** 画面の経路(`/console/`の下)。 */
const SCREEN_PATHS: readonly string[] = [
  "",
  "?approval=1",
  "?approval=3",
  "?failure=2",
  "?notice=1",
  "items",
  "items?tab=requirements",
  "items/7",
  "system",
  "jobs",
  "jobs?tab=history",
  "jobs?tab=schedules",
];

/** 違反を、規則、影響、要素の数と最初の要素で1行にする。差分で原因を辿れるようにする。 */
async function violationsOf(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .analyze();
  return results.violations.map((violation) => {
    const first = violation.nodes[0];
    const target = first === undefined ? "" : first.target.join(" ");
    return `${violation.id} (${violation.impact ?? "n/a"}) x${violation.nodes.length}: ${target}`;
  });
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test.describe(`screens (${theme}, ${mode})`, () => {
      test.use({ theme, mode });
      for (const path of SCREEN_PATHS) {
        test(`/console/${path} has no violations`, async ({ page }) => {
          await openScreen(page, path);

          expect(await violationsOf(page)).toEqual([]);
        });
      }
    });
  }

  test.describe(`dialogs (${theme})`, () => {
    test.use({ theme, mode: "normal" });

    test("the command palette has no violations", async ({ page }) => {
      await openScreen(page, "");
      await page.keyboard.press("ControlOrMeta+K");
      await expect(
        page.locator("dialog[data-command-palette][open]"),
      ).toBeVisible();

      expect(await violationsOf(page)).toEqual([]);
    });

    test("the shortcut help has no violations", async ({ page }) => {
      await openScreen(page, "");
      await page.getByRole("button", { name: "ショートカット" }).click();
      await expect(page.locator("dialog[open]")).toBeVisible();

      expect(await violationsOf(page)).toEqual([]);
    });

    test("the retry confirmation has no violations", async ({ page }) => {
      await openScreen(page, "?failure=2");
      await page.getByRole("button", { name: "再実行" }).click();
      await expect(page.locator("dialog[open]")).toBeVisible();
      await settle(page);

      expect(await violationsOf(page)).toEqual([]);
    });
  });
}
