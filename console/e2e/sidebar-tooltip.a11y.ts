// サイドバーの入口のツールチップが、たたんだ後に出っぱなしにならないことを確かめる。
// 広げた形でポインタを重ねただけで「開いた」状態が残ると、たたんだ瞬間に、残った分がすべて見える。

import { SIDEBAR_STORAGE_KEY } from "../src/lib/navigation.ts";
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
    // 開く遅延(300ms)より長く待つ。開いた状態は描画に出ないので、固定の時間で待つしかない。
    await page.waitForTimeout(500);
  }
  await page.mouse.move(900, 400);

  // ポインタを縁に当て、つまみで、たたむ。
  await page.mouse.move(256, 400);
  await page.getByRole("button", { name: "メニューの開閉" }).click();
  await expect(page.locator("aside")).toHaveCSS("width", "64px");

  await page.mouse.move(900, 400);

  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
});

test("a nav tooltip shows on hover while collapsed and closes after leaving", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "1");
  }, SIDEBAR_STORAGE_KEY);
  await openScreen(page, "");

  const tooltips = page.locator('[data-slot="tooltip-content"]');
  await page.locator("aside nav a").first().hover();
  await expect(tooltips).toHaveCount(1);

  // 実機のマウスと同じく、動きを何度かに分ける。Radixは、外れた後の次の動きを見て閉じる。
  await page.mouse.move(900, 400, { steps: 8 });
  await expect(tooltips).toHaveCount(0);
});
