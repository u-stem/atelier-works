// キーボードだけで画面を操作できることを、実際のTabとEscapeで確かめる。
// 順序のスナップショットは取らない。壊れては困る性質(見える、名前がある、閉じ込められない、
// サイドバーの後に本文、ダイアログの内側に留まる、閉じたら元へ戻る)だけを見る。

import type { Page } from "@playwright/test";
import {
  fillNewItem,
  NEW_ITEM_PATH,
  NEW_PR_REVIEW_PATH,
} from "./intakeStates.ts";
import { expect, openScreen, test } from "./support.ts";

/** Tabを押す回数の上限。画面の操作の数より十分に大きい値で、閉じ込めを見つける。 */
const MAX_TABS = 60;

type Stop = {
  /** 要素の位置を表す文字列。同じ要素かを見分ける。 */
  readonly signature: string;
  readonly isBody: boolean;
  readonly tabindex: number | null;
  readonly visible: boolean;
  readonly region: "skip" | "sidebar" | "main" | "other";
  /** アクセシビリティツリー上で、空でない名前を持つか。 */
  readonly hasName: boolean;
};

/** 今フォーカスがある要素の様子を読む。名前は、ブラウザが計算した値を使う。 */
async function readStop(page: Page): Promise<Stop> {
  const facts = await page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) {
      return { signature: "body", isBody: true };
    }
    const path: string[] = [];
    for (
      let node: Element | null = element;
      node !== null && node !== document.documentElement;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      const index =
        parent === null ? 0 : Array.from(parent.children).indexOf(node);
      path.unshift(`${node.tagName}:${index}`);
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inViewport =
      rect.width > 1 &&
      rect.height > 1 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    const rawTabindex = element.getAttribute("tabindex");
    let region: "skip" | "sidebar" | "main" | "other" = "other";
    if (element.matches('a[href="#main-content"]')) {
      region = "skip";
    } else if (element.closest("main") !== null) {
      region = "main";
    } else if (element.closest("aside, nav") !== null) {
      region = "sidebar";
    }
    return {
      signature: path.join(">"),
      isBody: false,
      tabindex: rawTabindex === null ? null : Number(rawTabindex),
      visible:
        inViewport && style.visibility === "visible" && style.opacity !== "0",
      region,
    };
  });
  if (facts.isBody) {
    return {
      signature: "body",
      isBody: true,
      tabindex: null,
      visible: true,
      region: "other",
      hasName: true,
    };
  }
  const snapshot = await page.locator(":focus").ariaSnapshot();
  // 名前に引用符などを含むと、先頭の行が`- 'link "..."':`の形になる。空でない名前の有無だけを見る。
  const hasName = /^- '?[a-z]+ "[^"]/.test(snapshot);
  return {
    signature: facts.signature,
    isBody: false,
    tabindex: facts.tabindex ?? null,
    visible: facts.visible ?? false,
    region: facts.region ?? "other",
    hasName,
  };
}

/**
 * Tabを繰り返し、止まった要素を順に集める。
 * 先頭に戻るか、ページの外(body)へ出たら、1周したとして止める。
 * 同じ要素に留まる、途中の要素へ戻る、上限までに1周しない、のいずれも閉じ込めとして記録する。
 */
async function walkTabs(
  page: Page,
): Promise<{ stops: Stop[]; trap: string | null }> {
  const stops: Stop[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (let count = 0; count < MAX_TABS; count += 1) {
    await page.keyboard.press("Tab");
    const stop = await readStop(page);
    if (stop.isBody) {
      return { stops, trap: null };
    }
    if (stop.signature === previous) {
      return { stops, trap: `focus stays on ${stop.signature}` };
    }
    if (seen.has(stop.signature)) {
      const first = stops[0];
      return {
        stops,
        trap:
          first !== undefined && first.signature === stop.signature
            ? null
            : `focus returns to ${stop.signature} before the page ends`,
      };
    }
    seen.add(stop.signature);
    stops.push(stop);
    previous = stop.signature;
  }
  return { stops, trap: `no exit within ${MAX_TABS} tabs` };
}

const ORDER: readonly string[] = ["skip", "sidebar", "main"];

/** 順に並ぶべき領域(スキップのリンク、サイドバー、本文)が、逆戻りしていないか。 */
function orderProblem(stops: readonly Stop[]): string | null {
  let rank = 0;
  for (const stop of stops) {
    const index = ORDER.indexOf(stop.region);
    if (index === -1) {
      return `a stop outside the skip link, sidebar and main: ${stop.signature}`;
    }
    if (index < rank) {
      return `${stop.region} comes after ${ORDER[rank]}: ${stop.signature}`;
    }
    rank = index;
  }
  return null;
}

function problemsOf(walk: { stops: Stop[]; trap: string | null }): string[] {
  const problems: string[] = [];
  if (walk.trap !== null) {
    problems.push(walk.trap);
  }
  // 最初のTabでbodyへ出ると、停止先が0件のまま「問題なし」になる。本文に1つも止まらない画面も同じ。
  if (walk.stops.length === 0) {
    problems.push("no tab stops");
  } else if (!walk.stops.some((stop) => stop.region === "main")) {
    problems.push("no tab stop in main");
  }
  const order = orderProblem(walk.stops);
  if (order !== null) {
    problems.push(order);
  }
  for (const stop of walk.stops) {
    if (stop.tabindex !== null && stop.tabindex > 0) {
      problems.push(`tabindex ${stop.tabindex}: ${stop.signature}`);
    }
    if (!stop.visible) {
      problems.push(`not visible: ${stop.signature}`);
    }
    if (!stop.hasName) {
      problems.push(`no accessible name: ${stop.signature}`);
    }
  }
  return problems;
}

const WALKED_PATHS: readonly string[] = [
  "",
  "?approval=1",
  "?failure=2",
  "items",
  "items/new",
  "items/new-pr-review",
  "items/7",
  "system",
  "jobs",
  "jobs?tab=history",
  "jobs?tab=schedules",
];

test.describe("tab walk", () => {
  for (const path of WALKED_PATHS) {
    test(`/console/${path} has reachable, visible, named stops in order`, async ({
      page,
    }) => {
      await openScreen(page, path);

      expect(problemsOf(await walkTabs(page))).toEqual([]);
    });
  }
});

// 検査自身の確認。最初のTabでbodyへ出て停止先が0件になる画面と、本文に止まらない画面を、
// 他の問題が無くても失敗にする。ここが通らないとき、画面の「問題なし」は何も意味しない。
test.describe("the tab walk check itself", () => {
  test("reports a page where the first Tab leaves the page", async ({
    page,
  }) => {
    await page.setContent(
      "<!doctype html><html lang=ja><head><title>canary</title></head><body><main><p>no focusable element</p></main></body></html>",
    );

    expect(problemsOf(await walkTabs(page))).toContain("no tab stops");
  });

  test("reports a page whose stops are all outside main", async ({ page }) => {
    await page.setContent(
      '<!doctype html><html lang=ja><head><title>canary</title></head><body><a href="#x">outside</a><main><p>no focusable element</p></main></body></html>',
    );

    expect(problemsOf(await walkTabs(page))).toContain("no tab stop in main");
  });
});

test.describe("skip link", () => {
  test("is shown by the first Tab", async ({ page }) => {
    await openScreen(page, "items");

    await page.keyboard.press("Tab");

    const box = await page
      .getByRole("link", { name: "本文へスキップ" })
      .boundingBox();
    expect(box?.width).toBeGreaterThan(1);
  });

  test("moves the focus to the main content on Enter", async ({ page }) => {
    await openScreen(page, "items");
    await page.keyboard.press("Tab");

    await page.keyboard.press("Enter");

    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("leaves the address without a fragment", async ({ page }) => {
    await openScreen(page, "items");
    await page.keyboard.press("Tab");

    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/^[^#]*$/);
  });
});

/** フォームの先頭に置く、一覧へ戻るリンク。ここから先のTabの順が、フォームの順になる。 */
const BACK_LINK = "作業項目の一覧";

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true });

/** フォームの先頭から、Tabを`presses`回押した位置を、順番の検査のために用意する。 */
async function tabFromBackLink(page: Page, presses: number): Promise<void> {
  await page.getByRole("link", { name: BACK_LINK }).focus();
  for (let count = 0; count < presses; count += 1) {
    await page.keyboard.press("Tab");
  }
}

type TabStep = { readonly name: string | RegExp };

/** 先頭のリンクの次から順に、Tabで止まる入力欄とボタンの名前。ラベルが入力欄に結ばれていることも示す。 */
const NEW_ITEM_ORDER: readonly TabStep[] = [
  { name: "リポジトリ" },
  // 進め方のラジオは1つの組で、選んでいる1つにだけ止まる。
  { name: /^通常/ },
  { name: "題名" },
  { name: "目的" },
  { name: "受入基準(任意)" },
  { name: "投入する" },
];

const NEW_ITEM_BUGFIX_ORDER: readonly TabStep[] = [
  { name: "リポジトリ" },
  { name: /^不具合の修正/ },
  { name: "題名" },
  { name: "目的" },
  { name: "再現手順" },
  { name: "期待する動作" },
  { name: "実際の動作" },
  { name: "受入基準(任意)" },
  { name: "承認なしで投入する" },
];

const NEW_PR_REVIEW_ORDER: readonly TabStep[] = [
  { name: "リポジトリ" },
  { name: "PRの番号またはURL" },
  { name: "レビューを投入する" },
];

/** 送信が起きたら、少なくとも1つの要求が出るまでに足りる、ネガティブの確認のための待ち。 */
const NO_SUBMIT_WAIT_MS = 400;

test.describe("new item form by keyboard", () => {
  test.describe("the order of the stops", () => {
    for (const [index, step] of NEW_ITEM_ORDER.entries()) {
      test(`Tab ${index + 1} from the back link stops at ${String(step.name)}`, async ({
        page,
      }) => {
        await openScreen(page, NEW_ITEM_PATH);

        await tabFromBackLink(page, index + 1);

        await expect(page.locator(":focus")).toHaveAccessibleName(step.name);
      });
    }

    for (const [index, step] of NEW_ITEM_BUGFIX_ORDER.entries()) {
      test(`Tab ${index + 1} from the back link stops at ${String(step.name)} for a bug fix`, async ({
        page,
      }) => {
        await openScreen(page, NEW_ITEM_PATH);
        await page.getByRole("radio", { name: /^不具合の修正/ }).check();

        await tabFromBackLink(page, index + 1);

        await expect(page.locator(":focus")).toHaveAccessibleName(step.name);
      });
    }

    test("the choice of a profile is one named group", async ({ page }) => {
      await openScreen(page, NEW_ITEM_PATH);

      await expect(page.getByRole("group", { name: "進め方" })).toBeVisible();
    });
  });

  test.describe("the profile choice", () => {
    test("moves to the next profile with the arrow key", async ({ page }) => {
      await openScreen(page, NEW_ITEM_PATH);
      await page.getByRole("radio", { name: /^通常/ }).focus();

      await page.keyboard.press("ArrowDown");

      await expect(page.getByRole("radio", { name: /^直接/ })).toBeChecked();
    });

    test("shows the profile on the submit button after the arrow key", async ({
      page,
    }) => {
      await openScreen(page, NEW_ITEM_PATH);
      await page.getByRole("radio", { name: /^通常/ }).focus();

      await page.keyboard.press("ArrowDown");

      await expect(
        page.getByRole("button", { name: "承認なしで投入する" }),
      ).toBeVisible();
    });

    test("does not submit a valid form on Enter", async ({ page, mock }) => {
      await openScreen(page, NEW_ITEM_PATH);
      await fillNewItem(page);
      await page.getByRole("radio", { name: /^通常/ }).focus();
      await page.keyboard.press("ArrowDown");

      await page.keyboard.press("Enter");
      await page.waitForTimeout(NO_SUBMIT_WAIT_MS);

      // 送ると書き込みのscriptが呼ばれ、受け口が中断して記録する。
      expect(mock.problems).toEqual([]);
    });
  });

  test.describe("the problems of the form", () => {
    test.beforeEach(async ({ page }) => {
      await openScreen(page, NEW_ITEM_PATH);
    });

    test("marks no field invalid before anything is sent", async ({ page }) => {
      await expect(field(page, "題名")).not.toHaveAttribute("aria-invalid");
    });

    test("shows the problems when Enter is pressed in a field", async ({
      page,
    }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(page.getByText("題名を入力してください。")).toBeVisible();
    });

    test("marks the empty title invalid", async ({ page }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "題名")).toHaveAttribute("aria-invalid", "true");
    });

    test("describes the empty title by its problem", async ({ page }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "題名")).toHaveAccessibleDescription(
        /題名を入力してください。/,
      );
    });

    test("describes the empty purpose by its problem", async ({ page }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "目的")).toHaveAccessibleDescription(
        /目的を入力してください。/,
      );
    });

    test("keeps the hint in the description next to the problem", async ({
      page,
    }) => {
      await field(page, "目的").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "目的")).toHaveAccessibleDescription(
        /Issueの本文になります。/,
      );
    });

    test("describes the title by its length before anything is sent", async ({
      page,
    }) => {
      await expect(field(page, "題名")).toHaveAccessibleDescription(
        "0 / 256字",
      );
    });
  });

  test("describes the repository by its hint", async ({ page }) => {
    await openScreen(page, NEW_ITEM_PATH);

    await expect(field(page, "リポジトリ")).toHaveAccessibleDescription(
      /「オーナー名\/リポジトリ名」の形で入力します。/,
    );
  });
});

test.describe("PR review form by keyboard", () => {
  test.describe("the order of the stops", () => {
    for (const [index, step] of NEW_PR_REVIEW_ORDER.entries()) {
      test(`Tab ${index + 1} from the back link stops at ${String(step.name)}`, async ({
        page,
      }) => {
        await openScreen(page, NEW_PR_REVIEW_PATH);

        await tabFromBackLink(page, index + 1);

        await expect(page.locator(":focus")).toHaveAccessibleName(step.name);
      });
    }
  });

  test.describe("the problems of the form", () => {
    test.beforeEach(async ({ page }) => {
      await openScreen(page, NEW_PR_REVIEW_PATH);
    });

    test("marks no field invalid before anything is sent", async ({ page }) => {
      await expect(field(page, "PRの番号またはURL")).not.toHaveAttribute(
        "aria-invalid",
      );
    });

    test("shows the problem when Enter is pressed in the empty field", async ({
      page,
    }) => {
      await field(page, "PRの番号またはURL").focus();

      await page.keyboard.press("Enter");

      await expect(
        page.getByText("PRの番号またはURLを入力してください。"),
      ).toBeVisible();
    });

    test("marks the empty pull request invalid", async ({ page }) => {
      await field(page, "PRの番号またはURL").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "PRの番号またはURL")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    test("describes the empty pull request by its problem", async ({
      page,
    }) => {
      await field(page, "PRの番号またはURL").focus();

      await page.keyboard.press("Enter");

      await expect(
        field(page, "PRの番号またはURL"),
      ).toHaveAccessibleDescription(/PRの番号またはURLを入力してください。/);
    });

    test("marks an invalid repository invalid", async ({ page }) => {
      await field(page, "リポジトリ").fill("invalid");
      await field(page, "PRの番号またはURL").fill("1");

      await page.keyboard.press("Enter");

      await expect(field(page, "リポジトリ")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    test("describes the repository by its hint next to the problem", async ({
      page,
    }) => {
      await field(page, "リポジトリ").fill("invalid");
      await field(page, "PRの番号またはURL").fill("1");

      await page.keyboard.press("Enter");

      await expect(field(page, "リポジトリ")).toHaveAccessibleDescription(
        /PRのURLを入力するときは、空のままでも構いません。.*入力してください。/,
      );
    });
  });
});

type DialogCase = {
  readonly name: string;
  /** 開く前の経路。 */
  readonly path: string;
  /** 開く操作の前にフォーカスを置く、元のボタン。 */
  readonly trigger: (page: Page) => ReturnType<Page["getByRole"]>;
  /** 元のボタンにフォーカスがある状態から、ダイアログを開く。 */
  readonly open: (page: Page) => Promise<void>;
};

const DIALOGS: readonly DialogCase[] = [
  {
    name: "command palette",
    path: "",
    trigger: (page) => page.getByRole("link", { name: "作業項目" }),
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
    },
  },
  {
    name: "shortcut help",
    path: "",
    trigger: (page) => page.getByRole("button", { name: "ショートカット" }),
    open: async (page) => {
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "retry confirmation",
    path: "?failure=2",
    trigger: (page) => page.getByRole("button", { name: "再実行" }),
    open: async (page) => {
      await page.keyboard.press("Enter");
    },
  },
];

for (const dialog of DIALOGS) {
  test.describe(`dialog: ${dialog.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await openScreen(page, dialog.path);
      await dialog.trigger(page).focus();
      await dialog.open(page);
      await expect(page.locator("dialog[open]")).toBeVisible();
    });

    test("puts the focus inside when it opens", async ({ page }) => {
      await expect(page.locator("dialog[open] :focus")).toHaveCount(1);
    });

    test("never moves the focus to the page behind while Tab is pressed repeatedly", async ({
      page,
    }) => {
      // モーダルの外は操作できない。最後の要素の次はブラウザの枠へ出るので、bodyも許す。
      const outside: string[] = [];
      for (let count = 0; count < 12; count += 1) {
        await page.keyboard.press("Tab");
        const where = await page.evaluate(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) {
            return "inside";
          }
          return active.closest("dialog[open]") === null
            ? active.tagName
            : "inside";
        });
        if (where !== "inside") {
          outside.push(where);
        }
      }

      expect(outside).toEqual([]);
    });

    test("closes on Escape", async ({ page }) => {
      await page.keyboard.press("Escape");

      await expect(page.locator("dialog[open]")).toHaveCount(0);
    });

    test("returns the focus to the button that opened it", async ({ page }) => {
      await page.keyboard.press("Escape");

      await expect(dialog.trigger(page)).toBeFocused();
    });
  });
}

type Destination = { readonly link: string; readonly title: string };

const DESTINATIONS: readonly Destination[] = [
  { link: "作業項目", title: "作業項目 - Factory Console" },
  { link: "ジョブ", title: "ジョブ - Factory Console" },
  { link: "システム", title: "システム - Factory Console" },
];

test.describe("navigation by keyboard", () => {
  for (const destination of DESTINATIONS) {
    test.describe(destination.link, () => {
      test.beforeEach(async ({ page }) => {
        await openScreen(page, "");
        await page.getByRole("link", { name: destination.link }).focus();
        await page.keyboard.press("Enter");
      });

      test("moves the focus to the heading", async ({ page }) => {
        await expect(page.locator("#page-heading")).toBeFocused();
      });

      test("updates the document title", async ({ page }) => {
        await expect(page).toHaveTitle(destination.title);
      });
    });
  }
});
