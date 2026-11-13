// 書き込みの5つの操作(承認、却下、中止、保留、全停止)を、ブラウザで押して結果の表示を確かめる。
// 結果は、成功、scriptの断り、5xxの3つを、検査ごとに受け口(`writes`)で選ぶ。
// 成功のトーストは時間で消え、関連する取得を読み直す。成功以外のトーストは、閉じるボタンで閉じるまで残る。
// 選んでいない書き込みが呼ばれると、受け口が記録し、共通の後始末(`support.ts`)が検査を失敗にする。

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { isRecord } from "../src/api/guards/primitives.ts";
import { THEMES, WCAG_TAGS } from "./axeScope.ts";
import { CANCELLABLE_WORK_ITEM_ID, RUNNING_FLOW_JOB } from "./fixtures.ts";
import type { MockApi } from "./mockApi.ts";
import { WRITE_SCRIPT, type WriteScript } from "./responses.ts";
import { expect, openScreen, test } from "./support.ts";

const QUERY = "f/factory/steps/console_query";
const HOLDS = "f/factory/console_holds";
const JOBS = "f/factory/console_jobs";

/** トーストの閉じるボタンの名前。 */
const CLOSE_LABEL = "知らせを閉じる";

/** 結果が分からない失敗の文に必ず入る案内。 */
const UNKNOWN_RESULT = "結果が分かりません。";

const APPROVAL_REFUSAL =
  "この依頼には、別の決定が記録済みか、期限が切れています。";

/** 文を含むトースト。 */
function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

function closeButtonOf(toast: Locator): Locator {
  return toast.getByRole("button", { name: CLOSE_LABEL });
}

/** 書き込みの後に読み直す取得。scriptと、引数の一部で指す。 */
type Read = {
  readonly script: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/** 受け口が応答した呼び出しのうち、取得に合うものの件数。読み直しを確かめるのに使う。 */
function callsOf(mock: MockApi, read: Read): number {
  return mock.calls.filter((call) => {
    const sent = call.args;
    return (
      call.script === read.script &&
      isRecord(sent) &&
      Object.entries(read.args).every(([key, value]) => sent[key] === value)
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

/** フォーカスの輪郭を描く計算値。輪郭(`outline`)と影(`box-shadow`)である。 */
function focusRingOf(toast: Locator): Promise<string> {
  return toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth} | ${style.boxShadow}`;
  });
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

async function cancelWorkItem(page: Page): Promise<void> {
  await page.getByRole("button", { name: "作業項目を中止" }).click();
  await confirmIn(page, "この作業項目を中止しますか", "中止する");
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
const SYSTEM = "system";

const SUMMARY: Read = { script: QUERY, args: { view: "summary" } };

/** 書き込みの操作と、結果ごとに期待する表示。 */
type Operation = {
  readonly name: string;
  /** 操作する画面の経路(`/console/`の下)。 */
  readonly path: string;
  readonly script: WriteScript;
  /** ボタンを押し、確認を通して送る。 */
  readonly act: (page: Page) => Promise<void>;
  /** 成功のトーストの文。 */
  readonly success: string;
  /** 成功の後に読み直す取得と、その名前。 */
  readonly rereads: { readonly name: string; readonly reads: readonly Read[] };
  /** 断りのトーストの文と色。 */
  readonly refusal: { readonly message: string; readonly type: string };
};

const OPERATIONS: readonly Operation[] = [
  {
    name: "approve",
    path: INBOX_APPROVAL,
    script: WRITE_SCRIPT.approval,
    act: approve,
    success: "承認しました。",
    rereads: { name: "the summary", reads: [SUMMARY] },
    refusal: { message: APPROVAL_REFUSAL, type: "error" },
  },
  {
    name: "reject",
    path: INBOX_APPROVAL,
    script: WRITE_SCRIPT.approval,
    act: reject,
    success: "却下しました。",
    rereads: { name: "the summary", reads: [SUMMARY] },
    refusal: { message: APPROVAL_REFUSAL, type: "error" },
  },
  {
    name: "cancel",
    path: `jobs/${RUNNING_FLOW_JOB.id}`,
    script: WRITE_SCRIPT.cancel,
    act: cancel,
    success: "ジョブを中止しました。",
    rereads: {
      name: "the job",
      reads: [{ script: JOBS, args: { view: "detail", include_output: true } }],
    },
    refusal: { message: "すでに終わっています。", type: "info" },
  },
  {
    name: "work item cancel",
    path: `items/${String(CANCELLABLE_WORK_ITEM_ID)}`,
    script: WRITE_SCRIPT.workItemCancel,
    act: cancelWorkItem,
    success: `作業項目 #${String(CANCELLABLE_WORK_ITEM_ID)} を中止しました。`,
    rereads: {
      name: "the work item",
      reads: [
        {
          script: QUERY,
          args: {
            view: "work_item_detail",
            work_item_id: CANCELLABLE_WORK_ITEM_ID,
          },
        },
        SUMMARY,
      ],
    },
    refusal: {
      message: "確かめている間に状態が変わったため",
      type: "info",
    },
  },
  {
    name: "hold",
    path: SYSTEM,
    script: WRITE_SCRIPT.place,
    act: placeHold,
    success: "マージの保留を置きました。",
    rereads: {
      name: "the holds",
      reads: [
        { script: HOLDS, args: {} },
        { script: QUERY, args: { view: "system_status" } },
      ],
    },
    refusal: { message: "有効な保留か凍結がすでにあります。", type: "info" },
  },
  {
    name: "stop all",
    path: SYSTEM,
    script: WRITE_SCRIPT.stopAll,
    act: stopAll,
    success: "全停止しました。",
    rereads: { name: "the holds", reads: [{ script: HOLDS, args: {} }] },
    refusal: { message: "全停止の状態を読めません。", type: "info" },
  },
];

for (const operation of OPERATIONS) {
  const { name, path, script, act, success, rereads, refusal } = operation;

  test.describe(name, () => {
    test.describe("success", () => {
      test.use({ writes: { [script]: "success" } });

      test(`${name}: a success shows a success toast`, async ({ page }) => {
        await openScreen(page, path);
        await act(page);

        await expect(toastWith(page, success)).toHaveAttribute(
          "data-type",
          "success",
        );
      });

      test(`${name}: a success reads ${rereads.name} again`, async ({
        page,
        mock,
      }) => {
        await openScreen(page, path);
        const counts = () => rereads.reads.map((read) => callsOf(mock, read));
        const before = counts();
        await act(page);

        await expect
          .poll(() =>
            counts().every((count, index) => count > (before[index] ?? 0)),
          )
          .toBe(true);
      });
    });

    test.describe("refusal", () => {
      test.use({ writes: { [script]: "refused" } });

      test(`${name}: a refusal shows a toast with a close button`, async ({
        page,
      }) => {
        await openScreen(page, path);
        await act(page);
        const toast = toastWith(page, refusal.message);

        await expect(toast).toHaveAttribute("data-type", refusal.type);
        await expect(closeButtonOf(toast)).toBeVisible();
      });
    });

    test.describe("server error", () => {
      test.use({ writes: { [script]: "server_error" } });

      test(`${name}: a server error shows a failure toast with a close button`, async ({
        page,
      }) => {
        await openScreen(page, path);
        await act(page);
        const toast = toastWith(page, UNKNOWN_RESULT);

        await expect(toast).toHaveAttribute("data-type", "error");
        await expect(closeButtonOf(toast)).toBeVisible();
      });
    });
  });
}

test.describe("a toast that stays", () => {
  test.describe("after a failure", () => {
    test.use({ writes: { [WRITE_SCRIPT.stopAll]: "server_error" } });

    test("a failure outlasts the lifetime of a success toast", async ({
      page,
    }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);
      await expect(toast).toBeVisible();
      // 成功のトーストの寿命(sonnerの既定の4秒)を超えて待つ。
      await page.waitForTimeout(6_000);

      await expect(toast).toBeVisible();
    });

    test("a failure goes with its close button", async ({ page }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);
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

    test("a toast focused with the keyboard shows a ring", async ({ page }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      const toast = toastWith(page, UNKNOWN_RESULT);
      await expect(toast).toBeVisible();
      const unfocused = await focusRingOf(toast);
      await page.keyboard.press("Alt+KeyT");
      await page.keyboard.press("Tab");
      await expect(toast).toBeFocused();

      // 影はフォーカスが無くても付くので、計算値が`none`でないだけでなく、フォーカスで変わることを見る。
      await expect.poll(() => focusRingOf(toast)).not.toBe(unfocused);
    });
  });

  test.describe("after a success", () => {
    test.use({ writes: { [WRITE_SCRIPT.stopAll]: "success" } });

    test("a success toast has a close button too", async ({ page }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);

      await expect(
        closeButtonOf(toastWith(page, "全停止しました。")),
      ).toBeVisible();
    });
  });

  test.describe("after two refusals", () => {
    test.use({
      writes: {
        [WRITE_SCRIPT.place]: "refused",
        [WRITE_SCRIPT.stopAll]: "refused",
      },
    });

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

for (const theme of THEMES) {
  test.describe(`axe with a toast that stays (${theme})`, () => {
    test.use({ writes: { [WRITE_SCRIPT.stopAll]: "server_error" }, theme });

    test(`a toast that stays passes axe (${theme})`, async ({ page }) => {
      await openScreen(page, SYSTEM);
      await stopAll(page);
      await expect(
        closeButtonOf(toastWith(page, UNKNOWN_RESULT)),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags([...WCAG_TAGS])
        .analyze();
      // トーストの文の色が測られずに通る事態を防ぐため、トーストだけを測った結果も見る。
      const toaster = await new AxeBuilder({ page })
        .include("[data-sonner-toaster]")
        .withTags([...WCAG_TAGS])
        .analyze();

      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      expect(toaster.passes.some((rule) => rule.id === "color-contrast")).toBe(
        true,
      );
    });
  });
}
