// `Dialog`の開閉の通知を、コマンドパレットを実際に開閉して確かめる。
// 利用者の操作(Esc)で閉じたら親へ知らせ(`onClose`)、親が`open`を偽にして閉じたときも、閉じるたびの後始末(`onClosed`)が走る。
// パレットは、`onClose`で親の状態を閉じ、`onClosed`で入力を消す。どちらも画面から見える。
// `open`を偽にしたときに`onClose`を呼ばないことは、親の状態が冪等で画面に出ないので、
// ここでは見えない。分岐は`notifyDialogClosed`の単体のテストが固定する。

import type { Page } from "@playwright/test";
import { expect, openScreen, test } from "./support.ts";

const PALETTE_INPUT = "コマンドパレット";

/** Reactが、閉じた通知(`close`イベント)による状態の更新を描き終えるまで待つ。 */
async function afterRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

/** パレットを開き、入力欄に文字を打つ。 */
async function openPaletteWithQuery(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.locator("dialog[open]")).toBeVisible();
  await page.getByRole("combobox").fill(query);
}

test.describe("Dialog open and close notifications", () => {
  test.beforeEach(async ({ page }) => {
    await openScreen(page, "");
  });

  test("tells the parent when Escape closes it, so the same shortcut opens it again", async ({
    page,
  }) => {
    await openPaletteWithQuery(page, "");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await afterRender(page);

    // 親が閉じたと知らないと、次のショートカットは閉じる側に回り、開かない。
    await page.keyboard.press("ControlOrMeta+K");

    await expect(
      page.getByRole("dialog", { name: PALETTE_INPUT }),
    ).toBeVisible();
  });

  test("runs the cleanup when Escape closes it", async ({ page }) => {
    await openPaletteWithQuery(page, "設定");
    await page.keyboard.press("Escape");
    await afterRender(page);

    await page.keyboard.press("ControlOrMeta+K");

    await expect(page.getByRole("combobox")).toHaveValue("");
  });

  test("runs the cleanup when the parent sets open to false", async ({
    page,
  }) => {
    await openPaletteWithQuery(page, "設定");
    // 開いたままのパレットでのショートカットは、親の`open`を偽にする。
    await page.keyboard.press("ControlOrMeta+K");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await afterRender(page);

    await page.keyboard.press("ControlOrMeta+K");

    await expect(page.getByRole("combobox")).toHaveValue("");
  });

  test("closes when the parent sets open to false", async ({ page }) => {
    await openPaletteWithQuery(page, "");

    await page.keyboard.press("ControlOrMeta+K");

    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });
});
