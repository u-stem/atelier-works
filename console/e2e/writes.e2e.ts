// 書き込みの5つの操作(承認、却下、中止、保留、全停止)を、ブラウザで押して結果の表示を確かめる。
// 結果は、成功、scriptの断り、5xxの3つを、検査ごとに受け口(`writes`)で選ぶ。
// 成功のトーストは時間で消え、関連する取得を読み直す。成功以外のトーストは、閉じるボタンで閉じるまで残る。
// 選んでいない書き込みが呼ばれると、受け口が記録し、共通の後始末(`support.ts`)が検査を失敗にする。

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { isRecord } from "../src/api/guards/primitives.ts";
import type { MockApi } from "./mockApi.ts";
import { expect, openScreen, type Theme, test } from "./support.ts";

const QUERY = "f/factory/steps/console_query";
const HOLDS = "f/factory/console_holds";
const JOBS = "f/factory/console_jobs";
const APPROVAL = "f/factory/approval_decide";
const CANCEL = "f/factory/console_job_cancel";
const PLACE = "f/factory/console_hold_place";
const STOP_ALL = "f/factory/console_stop_all";

const RUNNING_JOB_ID = "0190a1b2-c3d4-7e5f-8a9b-000000000002";

/** トーストの閉じるボタンの名前。 */
const CLOSE_LABEL = "知らせを閉じる";

/** 結果が分からない失敗の文に必ず入る案内。 */
const UNKNOWN_RESULT = "結果が分かりません。";

const APPROVAL_REFUSAL =
  "この依頼には、別の決定が記録済みか、期限が切れています。";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** 文を含むトースト。 */
function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

function closeButtonOf(toast: Locator): Locator {
  return toast.getByRole("button", { name: CLOSE_LABEL });
}

/** 受け口が応答した呼び出しのうち、scriptと引数の一部が合うものの件数。読み直しを確かめるのに使う。 */
function callsOf(
  mock: MockApi,
  script: string,
  args: Readonly<Record<string, unknown>> = {},
): number {
  return mock.calls.filter((call) => {
    const sent = call.args;
    return (
      call.script === script &&
      isRecord(sent) &&
      Object.entries(args).every(([key, value]) => sent[key] === value)
    );
  }).length;
}

/**
 * トーストの文が読める状態か。トーストから文書の根までと、文の入れ物が、どれも透明でない。
 * 重なったトーストは、前のもの以外の中身を透明にして畳むので、畳まれたトーストはここで偽になる。
 */
function isReadable(toast: Locator): Promise<boolean> {
  return toast.evaluate((element) => {
    const content = element.querySelector("[data-content]");
    if (content === null) return false;
    for (
      let node: Element | null = content;
      node !== null;
      node = node.parentElement
    ) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  });
}

/** 2つのトーストの枠が重なるか。 */
async function overlaps(first: Locator, second: Locator): Promise<boolean> {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (a === null || b === null) return true;
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 確認のダイアログの確認のボタンを押す。 */
async function confirmIn(
  page: Page,
  title: string,
  confirmLabel: string,
): Promise<void> {
  await page
    .getByRole("dialog", { name: title })
    .getByRole("button", { name: confirmLabel, exact: true })
    .click();
}

async function approve(page: Page): Promise<void> {
  await page.getByRole("button", { name: "承認する", exact: true }).click();
  await confirmIn(page, "この依頼を承認しますか", "承認する");
}

async function reject(page: Page): Promise<void> {
  await page.getByLabel("却下の理由").fill("e2e reject reason");
  await page.getByRole("button", { name: "却下する", exact: true }).click();
  await confirmIn(page, "この依頼を却下しますか", "却下する");
}

async function cancel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "ジョブを中止" }).click();
  await confirmIn(page, "このジョブを中止しますか", "中止する");
}

async function placeHold(page: Page): Promise<void> {
  await page.getByRole("button", { name: "保留や凍結を置く" }).click();
  const dialog = page.getByRole("dialog", { name: "保留か凍結を置きますか" });
  await dialog.getByLabel("対象").fill("o/r");
  await dialog.getByLabel("理由").fill("e2e hold reason");
  await dialog.getByRole("button", { name: "置く", exact: true }).click();
}

async function stopAll(page: Page): Promise<void> {
  await page.getByRole("button", { name: "全停止", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Factoryを全停止しますか" });
  await dialog.getByLabel("理由").fill("e2e stop reason");
  await dialog.getByRole("button", { name: "全停止する", exact: true }).click();
}

const INBOX_APPROVAL = "?approval=1";
const JOB_DETAIL = `jobs/${RUNNING_JOB_ID}`;
const SYSTEM = "system";

test.describe("approve", () => {
  test.describe("success", () => {
    test.use({ writes: { [APPROVAL]: "success" } });

    test("approve: a success shows a success toast and reads the summary again", async ({
      page,
      mock,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      const before = callsOf(mock, QUERY, { view: "summary" });
      await approve(page);

      await expect(toastWith(page, "承認しました。")).toHaveAttribute(
        "data-type",
        "success",
      );
      await expect
        .poll(() => callsOf(mock, QUERY, { view: "summary" }))
        .toBeGreaterThan(before);
    });
  });

  test.describe("refusal", () => {
    test.use({ writes: { [APPROVAL]: "refused" } });

    test("approve: a refusal shows a toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      await approve(page);
      const toast = toastWith(page, APPROVAL_REFUSAL);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });

  test.describe("server error", () => {
    test.use({ writes: { [APPROVAL]: "server_error" } });

    test("approve: a server error shows a failure toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      await approve(page);
      const toast = toastWith(page, UNKNOWN_RESULT);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });
});

test.describe("reject", () => {
  test.describe("success", () => {
    test.use({ writes: { [APPROVAL]: "success" } });

    test("reject: a success shows a success toast and reads the summary again", async ({
      page,
      mock,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      const before = callsOf(mock, QUERY, { view: "summary" });
      await reject(page);

      await expect(toastWith(page, "却下しました。")).toHaveAttribute(
        "data-type",
        "success",
      );
      await expect
        .poll(() => callsOf(mock, QUERY, { view: "summary" }))
        .toBeGreaterThan(before);
    });
  });

  test.describe("refusal", () => {
    test.use({ writes: { [APPROVAL]: "refused" } });

    test("reject: a refusal shows a toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      await reject(page);
      const toast = toastWith(page, APPROVAL_REFUSAL);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });

  test.describe("server error", () => {
    test.use({ writes: { [APPROVAL]: "server_error" } });

    test("reject: a server error shows a failure toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, INBOX_APPROVAL);
      await reject(page);
      const toast = toastWith(page, UNKNOWN_RESULT);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });
});

test.describe("cancel", () => {
  test.describe("success", () => {
    test.use({ writes: { [CANCEL]: "success" } });

    test("cancel: a success shows a success toast and reads the job again", async ({
      page,
      mock,
    }) => {
      await openScreen(page, JOB_DETAIL);
      const detail = { view: "detail", include_output: true };
      const before = callsOf(mock, JOBS, detail);
      await cancel(page);

      await expect(toastWith(page, "ジョブを中止しました。")).toHaveAttribute(
        "data-type",
        "success",
      );
      await expect
        .poll(() => callsOf(mock, JOBS, detail))
        .toBeGreaterThan(before);
    });
  });

  test.describe("refusal", () => {
    test.use({ writes: { [CANCEL]: "refused" } });

    test("cancel: a refusal shows a toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, JOB_DETAIL);
      await cancel(page);
      const toast = toastWith(page, "すでに終わっています。");

      await expect(toast).toHaveAttribute("data-type", "info");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });

  test.describe("server error", () => {
    test.use({ writes: { [CANCEL]: "server_error" } });

    test("cancel: a server error shows a failure toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, JOB_DETAIL);
      await cancel(page);
      const toast = toastWith(page, UNKNOWN_RESULT);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });
});

test.describe("hold", () => {
  test.describe("success", () => {
    test.use({ writes: { [PLACE]: "success" } });

    test("hold: a success shows a success toast and reads the holds again", async ({
      page,
      mock,
    }) => {
      await openScreen(page, SYSTEM);
      const holds = callsOf(mock, HOLDS);
      const status = callsOf(mock, QUERY, { view: "system_status" });
      await placeHold(page);

      await expect(
        toastWith(page, "マージの保留を置きました。"),
      ).toHaveAttribute("data-type", "success");
      await expect.poll(() => callsOf(mock, HOLDS)).toBeGreaterThan(holds);
      await expect
        .poll(() => callsOf(mock, QUERY, { view: "system_status" }))
        .toBeGreaterThan(status);
    });
  });

  test.describe("refusal", () => {
    test.use({ writes: { [PLACE]: "refused" } });

    test("hold: a refusal shows a toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await placeHold(page);
      const toast = toastWith(page, "有効な保留か凍結がすでにあります。");

      await expect(toast).toHaveAttribute("data-type", "info");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });

  test.describe("server error", () => {
    test.use({ writes: { [PLACE]: "server_error" } });

    test("hold: a server error shows a failure toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await placeHold(page);
      const toast = toastWith(page, UNKNOWN_RESULT);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });
});

test.describe("stop all", () => {
  test.describe("success", () => {
    test.use({ writes: { [STOP_ALL]: "success" } });

    test("stop all: a success shows a success toast and reads the holds again", async ({
      page,
      mock,
    }) => {
      await openScreen(page, SYSTEM);
      const before = callsOf(mock, HOLDS);
      await stopAll(page);

      await expect(toastWith(page, "全停止しました。")).toHaveAttribute(
        "data-type",
        "success",
      );
      await expect.poll(() => callsOf(mock, HOLDS)).toBeGreaterThan(before);
    });
  });

  test.describe("refusal", () => {
    test.use({ writes: { [STOP_ALL]: "refused" } });

    test("stop all: a refusal shows a toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, "全停止の状態を読めません。");

      await expect(toast).toHaveAttribute("data-type", "info");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });

  test.describe("server error", () => {
    test.use({ writes: { [STOP_ALL]: "server_error" } });

    test("stop all: a server error shows a failure toast with a close button", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);

      await expect(toast).toHaveAttribute("data-type", "error");
      await expect(closeButtonOf(toast)).toBeVisible();
    });
  });
});

test.describe("a toast that stays", () => {
  test.describe("after a failure", () => {
    test.use({ writes: { [STOP_ALL]: "server_error" } });

    test("a failure outlasts the lifetime of a success toast and goes with its close button", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);
      await expect(toast).toBeVisible();
      // 成功のトーストの寿命(sonnerの既定の4秒)を超えて待つ。
      await page.waitForTimeout(6_000);

      await expect(toast).toBeVisible();
      await closeButtonOf(toast).click();
      await expect(toast).toHaveCount(0);
    });

    test("the close button is reached and pressed with the keyboard", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);
      await expect(toast).toBeVisible();
      // sonnerの既定のキー(Alt+T)で、トーストの並びへ移る。並びの次はトースト、その次が閉じるボタンである。
      await page.keyboard.press("Alt+KeyT");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");

      await expect(closeButtonOf(toast)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toast).toHaveCount(0);
    });
  });

  test.describe("after two refusals", () => {
    test.use({ writes: { [PLACE]: "refused", [STOP_ALL]: "refused" } });

    test("two toasts that stay can both be read", async ({ page }) => {
      const hold = toastWith(page, "有効な保留か凍結がすでにあります。");
      const stop = toastWith(page, "全停止の状態を読めません。");
      await openScreen(page, SYSTEM);
      await placeHold(page);
      await expect(hold).toBeVisible();
      await stopAll(page);
      await expect(stop).toBeVisible();
      // ポインタがトーストに重なると、sonnerは畳んだトーストを広げる。置き場の外へ出して確かめる。
      await page.mouse.move(0, 0);

      await expect(hold).toBeInViewport();
      await expect(stop).toBeInViewport();
      expect(await isReadable(hold)).toBe(true);
      expect(await isReadable(stop)).toBe(true);
      expect(await overlaps(hold, stop)).toBe(false);
    });
  });
});

const THEMES: readonly Theme[] = ["light", "dark"];

for (const theme of THEMES) {
  test.describe(`axe with a toast that stays (${theme})`, () => {
    test.use({ writes: { [STOP_ALL]: "server_error" }, theme });

    test(`a toast that stays passes axe (${theme})`, async ({ page }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      await expect(
        closeButtonOf(toastWith(page, UNKNOWN_RESULT)),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();
      // トーストの文の色が測られずに通る事態を防ぐため、トーストだけを測った結果も見る。
      const toaster = await new AxeBuilder({ page })
        .include("[data-sonner-toaster]")
        .withTags(WCAG_TAGS)
        .analyze();

      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      expect(toaster.passes.some((rule) => rule.id === "color-contrast")).toBe(
        true,
      );
    });
  });
}
