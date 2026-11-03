// ブラウザの検査の共通の部品。テーマの指定、APIの受け口、画面が落ち着くまでの待ち。

import base, { expect, type Page } from "@playwright/test";
import { THEME_STORAGE_KEY } from "../src/lib/theme.ts";
import { installMockApi, type MockApi } from "./mockApi.ts";
import { ORIGIN } from "./origin.ts";
import type { Mode } from "./responses.ts";

export type Theme = "light" | "dark";
export type { Mode };

type Options = {
  mode: Mode;
  theme: Theme;
};

type Fixtures = {
  /** 受け口。検査の最後に、想定外の要求が無かったことを確かめる。 */
  mock: MockApi;
};

export const test = base.extend<Options & Fixtures>({
  mode: ["normal", { option: true }],
  theme: ["light", { option: true }],
  mock: [
    async ({ page, mode, theme }, use) => {
      await page.addInitScript(
        ({ key, value }) => {
          window.localStorage.setItem(key, value);
        },
        { key: THEME_STORAGE_KEY, value: theme },
      );
      const mock = await installMockApi(page, ORIGIN, mode);
      await use(mock);
      expect(mock.problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** 見出しが出て、取得が終わり、スケルトンが消えるまで待つ。 */
export async function settle(page: Page): Promise<void> {
  await expect(page.locator("#page-heading")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

/** `/console/`の下の経路を開き、落ち着くまで待つ。 */
export async function openScreen(page: Page, path: string): Promise<void> {
  await page.goto(`/console/${path}`);
  await settle(page);
}
