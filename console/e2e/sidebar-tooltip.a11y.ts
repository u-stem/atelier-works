// サイドバーの入口のチップ(ツールチップ)が、たたんだ後に出っぱなしにならないことを確かめる。
// 広げた状態では、チップの中身を描かない。ポインタを重ねただけで「開いた」状態が残ると、たたんだときに、残った分が一斉に出る。

import { expect, openScreen, test } from "./support.ts";

test("nav tooltips do not stay open after the sidebar is collapsed", async ({
  page,
}) => {
  await openScreen(page, "");

  const links = page.locator("aside nav a");
  const count = await links.count();
  expect(count).toBeGreaterThan(1);
  for (let index = 0; index < count; index += 1) {
    await links.nth(index).hover();
    await page.waitForTimeout(500);
  }
  await page.mouse.move(900, 400);

  // ポインタを縁に当て、つまみで、たたむ。
  await page.mouse.move(256, 400);
  await page.getByRole("button", { name: "メニューの開閉" }).click();
  await expect(page.locator("aside")).toHaveCSS("width", "64px");

  await page.mouse.move(900, 400);
  await page.waitForTimeout(600);

  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
});
