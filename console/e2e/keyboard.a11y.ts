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
  "?approval=4",
  "?failure=2",
  "items",
  "items/new",
  "items/new-pr-review",
  "items/7",
  "items/7?tab=design",
  "items/7/design",
  "items/7/requirements",
  "system",
  "jobs",
  "jobs?tab=history",
  "jobs?tab=schedules",
  "jobs/origins/poll_prs",
  "jobs/origins/poll_issues",
  "jobs/origins/poll_dependabot",
  "jobs/origins/self_update",
  "jobs/flows/implement",
  "jobs/flows/pr_review",
  "jobs/flows/pr_fix",
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

/** 誤りの件数を読み上げるための、視覚的に隠した領域。 */
const problemStatus = (page: Page) => page.locator('form [role="status"]');

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

/**
 * フォームのsubmitイベントを数え始める。暗黙の送信は、キーの押下と同じ処理の中でsubmitイベントを起こす。
 * 押下が返った後に数を読めば、時間で待たずに、送信が起きたかを確定できる。
 */
async function countSubmitEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    let count = 0;
    document.querySelector("form")?.addEventListener("submit", () => {
      count += 1;
    });
    Object.defineProperty(window, "submitEvents", { get: () => count });
  });
}

const submitEvents = (page: Page) =>
  page.evaluate(() => Reflect.get(window, "submitEvents"));

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

    test("does not submit a valid form on Enter", async ({ page }) => {
      await openScreen(page, NEW_ITEM_PATH);
      await fillNewItem(page);
      await page.getByRole("radio", { name: /^通常/ }).focus();
      await page.keyboard.press("ArrowDown");
      await countSubmitEvents(page);

      await page.keyboard.press("Enter");

      expect(await submitEvents(page)).toBe(0);
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

    test("lists the hint and the problem together in the description of the purpose", async ({
      page,
    }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "目的")).toHaveAccessibleDescription(
        /Issueの本文になります。.*目的を入力してください。/,
      );
    });

    test("describes the title by its length before anything is sent", async ({
      page,
    }) => {
      await expect(field(page, "題名")).toHaveAccessibleDescription(
        "0 / 256字",
      );
    });

    test("announces the number of problems when Enter is pressed in the first invalid field", async ({
      page,
    }) => {
      await field(page, "題名").focus();

      await page.keyboard.press("Enter");

      await expect(problemStatus(page)).toHaveText("入力に誤りがあります(2件)");
    });

    test("announces nothing by the status region when the focus moves to the first invalid field", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "投入する" }).click();
      await expect(field(page, "題名")).toBeFocused();

      await expect(problemStatus(page)).toHaveText("");
    });

    test("moves the focus to the first empty field when the submit button is clicked", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "投入する" }).click();

      await expect(field(page, "題名")).toBeFocused();
    });

    test("moves the focus to the first empty field when Enter is pressed on the submit button", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "投入する" }).focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "題名")).toBeFocused();
    });

    test("moves the focus to the purpose when only the purpose is empty", async ({
      page,
    }) => {
      await field(page, "題名").fill("example title");

      await page.getByRole("button", { name: "投入する" }).click();

      await expect(field(page, "目的")).toBeFocused();
    });

    test("moves the focus to the repository when it is invalid and the title is empty", async ({
      page,
    }) => {
      await field(page, "リポジトリ").fill("invalid");

      await page.getByRole("button", { name: "投入する" }).click();

      await expect(field(page, "リポジトリ")).toBeFocused();
    });

    test("moves the focus to the first of the fields of a bug fix", async ({
      page,
    }) => {
      await page.getByRole("radio", { name: /^不具合の修正/ }).check();
      await field(page, "題名").fill("example title");
      await field(page, "目的").fill("example purpose");

      await page.getByRole("button", { name: "承認なしで投入する" }).click();

      await expect(field(page, "再現手順")).toBeFocused();
    });

    test("moves the focus again on each submit with a problem", async ({
      page,
    }) => {
      const submit = page.getByRole("button", { name: "投入する" });
      await submit.click();
      await submit.focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "題名")).toBeFocused();
    });

    test("leaves the focus where the user moves it after a problem is shown", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "投入する" }).click();
      await field(page, "題名").fill("example title");

      await page.keyboard.press("Tab");

      await expect(field(page, "目的")).toBeFocused();
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

    test("announces the number of problems when Enter is pressed in the invalid field", async ({
      page,
    }) => {
      await field(page, "PRの番号またはURL").focus();

      await page.keyboard.press("Enter");

      await expect(problemStatus(page)).toHaveText("入力に誤りがあります(1件)");
    });

    test("moves the focus to the pull request when the submit button is clicked", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "レビューを投入する" }).click();

      await expect(field(page, "PRの番号またはURL")).toBeFocused();
    });

    test("moves the focus to the pull request when Enter is pressed on the submit button", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "レビューを投入する" }).focus();

      await page.keyboard.press("Enter");

      await expect(field(page, "PRの番号またはURL")).toBeFocused();
    });

    test("moves the focus to the repository when it is invalid", async ({
      page,
    }) => {
      await field(page, "リポジトリ").fill("invalid");
      await field(page, "PRの番号またはURL").fill("1");

      await page.getByRole("button", { name: "レビューを投入する" }).click();

      await expect(field(page, "リポジトリ")).toBeFocused();
    });

    test("leaves the focus where the user moves it while another problem remains", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "レビューを投入する" }).click();
      // 番号だけではリポジトリが要るので、PR欄を直しても、リポジトリ欄の誤りが残る。
      await field(page, "PRの番号またはURL").fill("1");
      await field(page, "リポジトリ")
        .and(page.locator('[aria-invalid="true"]'))
        .waitFor();
      await field(page, "PRの番号またはURL").focus();

      await page.keyboard.press("Tab");

      await expect(
        page.getByRole("button", { name: "レビューを投入する" }),
      ).toBeFocused();
    });
  });
});

/** 起動の図の見出しのボタン。名前は「<flow名>のステップ」。 */
function flowHeading(page: Page, flow: string) {
  return page.getByRole("button", { name: `${flow}のステップ`, exact: true });
}

/** Tabを押して、`target`にフォーカスを移す。上限までに届かなければ、届いていないまま返す。 */
async function tabTo(
  page: Page,
  target: ReturnType<Page["getByRole"]>,
): Promise<void> {
  for (let count = 0; count < MAX_TABS; count += 1) {
    await page.keyboard.press("Tab");
    const focused = await target.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused) return;
  }
}

test.describe("origin diagram", () => {
  test.beforeEach(async ({ page }) => {
    await openScreen(page, "jobs/origins/poll_prs");
    await tabTo(page, flowHeading(page, "pr_fix"));
  });

  test("reaches a heading by Tab", async ({ page }) => {
    await expect(flowHeading(page, "pr_fix")).toBeFocused();
  });

  test("starts with the flow closed", async ({ page }) => {
    await expect(flowHeading(page, "pr_fix")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("opens the flow on Enter", async ({ page }) => {
    await page.keyboard.press("Enter");

    await expect(flowHeading(page, "pr_fix")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("keeps the focus on the heading after Enter", async ({ page }) => {
    await page.keyboard.press("Enter");

    await expect(flowHeading(page, "pr_fix")).toBeFocused();
  });

  test("shows the steps of the flow after Enter", async ({ page }) => {
    await page.keyboard.press("Enter");

    await expect(page.getByText("pr_fix_collect")).toBeVisible();
  });

  test("closes the flow on a second Enter", async ({ page }) => {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    await expect(flowHeading(page, "pr_fix")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("does not open the flow while Space is held down", async ({ page }) => {
    await page.keyboard.down("Space");

    await expect(flowHeading(page, "pr_fix")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("opens the flow when Space is released", async ({ page }) => {
    await page.keyboard.down("Space");
    await page.keyboard.up("Space");

    await expect(flowHeading(page, "pr_fix")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("keeps the focus on the heading after Space", async ({ page }) => {
    await page.keyboard.press("Space");

    await expect(flowHeading(page, "pr_fix")).toBeFocused();
  });

  test("does not scroll the page by Space", async ({ page }) => {
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Space");

    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });

  test("moves the focus from the open heading to the link to the diagram of the flow", async ({
    page,
  }) => {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");

    await expect(
      page.getByRole("link", { name: "flowの図: pr_fix" }),
    ).toBeFocused();
  });

  test("opens the diagram of the flow from that link without closing the heading", async ({
    page,
  }) => {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/console\/jobs\/flows\/pr_fix$/);
  });

  test("keeps the open flows when the width falls below the list width", async ({
    page,
  }) => {
    await page.keyboard.press("Enter");
    await page.setViewportSize({ width: 500, height: 800 });

    await expect(page.locator("details[open] > summary")).toHaveCount(1);
  });

  test("keeps the open flows when the width returns to the diagram width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.locator("details > summary").first().click();
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(
      page.getByRole("button", { name: /のステップ$/ }).first(),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("origin diagram of a schedule that launches one flow", () => {
  test("starts with the only flow open", async ({ page }) => {
    await openScreen(page, "jobs/origins/poll_issues");

    await expect(flowHeading(page, "pipeline")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
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

// 本文の表示の形式の切り替え。Tab、Enter、Spaceだけで操作でき、押した選択肢が`aria-pressed`で示される。
// 承認画面の要件定義には、取り込み時点のIssueの切り替え(原文が既定)も並ぶ。
// 要件定義書の切り替えは、読み上げの名前(group)で絞る。
test.describe("view mode switch by keyboard", () => {
  const SWITCH_PATHS: readonly { path: string; group: string | null }[] = [
    { path: "items/7/requirements", group: null },
    { path: "?approval=1", group: "要件定義書の表示の形式" },
    { path: "items/7/design", group: null },
  ];

  for (const { path, group } of SWITCH_PATHS) {
    const scope = (page: Page) =>
      group === null ? page : page.getByRole("group", { name: group });
    test.describe(`/console/${path}`, () => {
      test.beforeEach(async ({ page }) => {
        await openScreen(page, path);
        for (let count = 0; count < MAX_TABS; count += 1) {
          await page.keyboard.press("Tab");
          if (
            await scope(page)
              .getByRole("button", { name: "プレビュー" })
              .evaluate((element) => element === document.activeElement)
          ) {
            return;
          }
        }
        throw new Error("the preview choice is not reachable by Tab");
      });

      test("starts as the preview", async ({ page }) => {
        await expect(
          scope(page).getByRole("button", { name: "プレビュー" }),
        ).toHaveAttribute("aria-pressed", "true");
      });

      test("chooses the text on Enter", async ({ page }) => {
        await page.keyboard.press("Tab");

        await page.keyboard.press("Enter");

        await expect(
          scope(page).getByRole("button", { name: "Markdownの文字" }),
        ).toHaveAttribute("aria-pressed", "true");
      });

      test("returns to the preview on Space", async ({ page }) => {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Shift+Tab");

        await page.keyboard.press("Space");

        await expect(
          scope(page).getByRole("button", { name: "プレビュー" }),
        ).toHaveAttribute("aria-pressed", "true");
      });

      test("keeps the focus on the choice that was chosen", async ({
        page,
      }) => {
        await page.keyboard.press("Tab");

        await page.keyboard.press("Enter");

        await expect(
          scope(page).getByRole("button", { name: "Markdownの文字" }),
        ).toBeFocused();
      });
    });
  }
});

// 承認画面の本文の切り替え(取り込み時点のIssueと提案の本文)。原文が既定で、プレビューは参考の表示である。
// プレビューを表示している間は承認を止め、原文に戻すと、原文を確かめたかのチェックを求める。
// チェックを入れると承認できる。却下の理由の欄は、切り替えで変わらない。
test.describe("approval body preview by keyboard", () => {
  const SCREENS: readonly {
    path: string;
    group: string;
    reason: string;
    check: string;
  }[] = [
    {
      path: "?approval=1",
      group: "取り込み時点のIssueの表示の形式",
      reason: "取り込み時点のIssueをプレビューで表示中は承認できません。",
      check: "取り込み時点のIssueのプレビューを表示しました。",
    },
    {
      path: "?approval=4",
      group: "提案の本文の表示の形式",
      reason: "提案の本文をプレビューで表示中は承認できません。",
      check: "提案の本文のプレビューを表示しました。",
    },
  ];

  /** 切り替えの選択肢をキーボードで押す。 */
  async function choose(page: Page, group: string, label: string) {
    await page
      .getByRole("group", { name: group })
      .getByRole("button", { name: label })
      .focus();
    await page.keyboard.press("Enter");
  }

  for (const { path, group, reason, check } of SCREENS) {
    const approve = (page: Page) =>
      page.getByRole("button", { name: "承認する" });
    test.describe(`/console/${path}`, () => {
      test("starts as the source and lets the approval through", async ({
        page,
      }) => {
        await openScreen(page, path);

        await expect(approve(page)).toBeEnabled();
      });

      test("stops the approval in the preview and says why", async ({
        page,
      }) => {
        await openScreen(page, path);

        await choose(page, group, "プレビュー");

        await expect(page.getByText(reason)).toBeVisible();
        await expect(approve(page)).toBeDisabled();
      });

      test("asks for the check of the source after the preview", async ({
        page,
      }) => {
        await openScreen(page, path);
        await choose(page, group, "プレビュー");

        await choose(page, group, "原文");

        await expect(page.getByText(reason)).toHaveCount(0);
        await expect(approve(page)).toBeDisabled();
      });

      test("lets the approval through once the check is done", async ({
        page,
      }) => {
        await openScreen(page, path);
        await choose(page, group, "プレビュー");
        await choose(page, group, "原文");

        await page.getByLabel(new RegExp(`^${check}`)).check();

        await expect(approve(page)).toBeEnabled();
      });

      test("stops the approval again when the preview is chosen after the check", async ({
        page,
      }) => {
        await openScreen(page, path);
        await choose(page, group, "プレビュー");
        await choose(page, group, "原文");
        await page.getByLabel(new RegExp(`^${check}`)).check();

        await choose(page, group, "プレビュー");

        await expect(approve(page)).toBeDisabled();
      });

      test("keeps the rejection reason as it was", async ({ page }) => {
        await openScreen(page, path);
        const field = page.getByLabel(/^却下の理由/);
        await field.fill("reason text");

        await choose(page, group, "プレビュー");

        await expect(field).toHaveValue("reason text");
      });
    });
  }
});

// 形式を往復した後も、目次が出て、選んだ節を強調する。
// 「Markdownの文字」では見出しの要素が消えるので、プレビューへ戻ったときに取り直せていることを確かめる。
// 古い要素を測ると、どの見出しも位置が0になり、最後の節が強調される。
// 設計書の固定データは節が2つあるので、最初の節を選んで、強調が選んだ節に付くことを見る。
test.describe("table of contents after the text mode", () => {
  test("highlights the chosen section after returning to the preview", async ({
    page,
  }) => {
    await openScreen(page, "items/7/design");
    await page.getByRole("button", { name: "Markdownの文字" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("navigation", { name: "目次" })).toHaveCount(0);
    await page.getByRole("button", { name: "プレビュー" }).focus();
    await page.keyboard.press("Enter");
    const first = page
      .getByRole("navigation", { name: "目次" })
      .getByRole("link")
      .first();
    await first.focus();

    await page.keyboard.press("Enter");

    await expect(first).toHaveAttribute("aria-current", "location");
  });
});
