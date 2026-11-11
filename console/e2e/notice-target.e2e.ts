// 作業項目を名指しする通知の詳細から、その作業項目の失敗へ1回の操作で移れることを、ブラウザで確かめる。
// 履歴は置き換え、移った後のフォーカスは詳細のペインに置き、種類のチップが失敗を隠すときは「すべて」に戻す。
// 再実行のボタンは押さない。受け口は書き込みに応答しないので、押すと検査が落ちる。

import AxeBuilder from "@axe-core/playwright";
import { THEMES, WCAG_TAGS } from "./axeScope.ts";
import { expect, openScreen, test } from "./support.ts";

const TO_FAILURE = "作業項目 #2の失敗へ";

/** 詳細のペイン。選んだ項目が替わっても、ペイン自体は残る。 */
const DETAIL_PANE = "選んだ項目の概要";

test("a notice that names a work item leads to the failure of that work item", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");

  await page.getByRole("button", { name: TO_FAILURE }).click();

  await expect(page).toHaveURL(/\/console\/?\?failure=2$/);
});

test("the failure the button leads to has the retry button", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");

  await page.getByRole("button", { name: TO_FAILURE }).click();

  await expect(
    page.getByRole("region", { name: "再実行" }).getByRole("button", {
      name: "再実行",
    }),
  ).toBeVisible();
});

test("the button replaces the history entry of the notice instead of adding one", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");
  const before = await page.evaluate(() => window.history.length);

  await page.getByRole("button", { name: TO_FAILURE }).click();
  await expect(page).toHaveURL(/\?failure=2$/);

  expect(await page.evaluate(() => window.history.length)).toBe(before);
});

test("the focus moves to the detail pane when the failure opens", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");

  await page.getByRole("button", { name: TO_FAILURE }).click();

  await expect(page.getByRole("region", { name: DETAIL_PANE })).toBeFocused();
});

test("the kind filter that hides the failure goes back to all", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");
  const kinds = page.getByRole("group", { name: "種類で絞り込む" });
  await kinds.getByRole("button", { name: /^通知/ }).click();
  await expect(page.locator('[data-row="failure:2"]')).toHaveCount(0);

  await page.getByRole("button", { name: TO_FAILURE }).click();

  await expect(kinds.getByRole("button", { name: /^すべて/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the failure row is in the list once the filter went back to all", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");
  await page
    .getByRole("group", { name: "種類で絞り込む" })
    .getByRole("button", { name: /^通知/ })
    .click();

  await page.getByRole("button", { name: TO_FAILURE }).click();

  await expect(page.locator('[data-row="failure:2"]')).toBeVisible();
});

test.describe("in a narrow window", () => {
  test.use({ viewport: { width: 600, height: 900 } });

  test("one press of back to the list leaves the failure, after the notice was opened from the list", async ({
    page,
  }) => {
    await openScreen(page, "");
    await page.locator('[data-row="notice:1"]').click();
    await page.getByRole("button", { name: TO_FAILURE }).click();
    await expect(page).toHaveURL(/\?failure=2$/);

    await page.getByRole("button", { name: "一覧へ戻る" }).click();

    await expect(page).toHaveURL(/\/console\/?$/);
  });

  test("the list shows again after that press", async ({ page }) => {
    await openScreen(page, "");
    await page.locator('[data-row="notice:1"]').click();
    await page.getByRole("button", { name: TO_FAILURE }).click();

    await page.getByRole("button", { name: "一覧へ戻る" }).click();

    await expect(
      page.getByRole("region", { name: "要対応の一覧" }),
    ).toBeVisible();
  });

  test("the focus moves to the detail pane when the failure opens", async ({
    page,
  }) => {
    await openScreen(page, "");
    await page.locator('[data-row="notice:1"]').click();

    await page.getByRole("button", { name: TO_FAILURE }).click();

    await expect(page.getByRole("region", { name: DETAIL_PANE })).toBeFocused();
  });
});

for (const theme of THEMES) {
  test.describe(`axe after the button opened the failure (${theme})`, () => {
    test.use({ theme });

    test(`the failure the button leads to passes axe (${theme})`, async ({
      page,
    }) => {
      await openScreen(page, "?notice=1");
      await page.getByRole("button", { name: TO_FAILURE }).click();
      await expect(page).toHaveURL(/\?failure=2$/);
      await expect(page.getByRole("region", { name: "再実行" })).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags([...WCAG_TAGS])
        .analyze();

      expect(results.violations.map((violation) => violation.id)).toEqual([]);
    });
  });
}
