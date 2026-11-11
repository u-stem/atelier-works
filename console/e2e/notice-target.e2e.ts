// 作業項目を名指しする通知の詳細から、その作業項目の失敗へ1回の操作で移れることを、ブラウザで確かめる。
// 再実行のボタンは押さない。受け口は書き込みに応答しないので、押すと検査が落ちる。

import { expect, openScreen, test } from "./support.ts";

test("a notice that names a work item leads to the failure of that work item", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");

  await page.getByRole("link", { name: "作業項目 #2の失敗へ" }).click();

  await expect(page).toHaveURL(/\/console\/\?failure=2$/);
});

test("the failure the button leads to has the retry button", async ({
  page,
}) => {
  await openScreen(page, "?notice=1");

  await page.getByRole("link", { name: "作業項目 #2の失敗へ" }).click();

  await expect(
    page.getByRole("region", { name: "再実行" }).getByRole("button", {
      name: "再実行",
    }),
  ).toBeVisible();
});
