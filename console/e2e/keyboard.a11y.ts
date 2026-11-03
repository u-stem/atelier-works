// キーボードだけで画面を操作できることを、実際のTabとEscapeで確かめる。
// 順序のスナップショットは取らない。壊れては困る性質(見える、名前がある、閉じ込められない、
// サイドバーの後に本文、ダイアログの内側に留まる、閉じたら元へ戻る)だけを見る。

import type { Page } from "@playwright/test";
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
  "items/7",
  "system",
  "jobs",
  "jobs?tab=history",
  "jobs?tab=schedules",
  "jobs/origins/poll_prs",
  "jobs/origins/poll_issues",
  "jobs/origins/poll_dependabot",
  "jobs/flows/implement",
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
      page.getByRole("link", { name: "pr_fixの図を開く" }),
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
