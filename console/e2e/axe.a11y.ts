// 画面とダイアログを、axe-coreで検査する。WCAG 2.0と2.1のAとAAの規則だけを見る。
// 検査は、ビルド済みのConsoleを、テーマ(ライト、ダーク)と、データの有る無しの組み合わせで開いて行う。
// 規則の無効化、検査の対象からの除外、既知の違反の許容リストは持たない。
// 検査が何も測らずに通る事態を防ぐため、違反を埋めたページで違反が出ること、
// 規則が1つ以上通ること、文字のコントラストが測られたこと、テーマの属性が意図どおりであることも、画面ごとに確かめる。

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { INTAKE_STATES } from "./intakeStates.ts";
import {
  expect,
  type Mode,
  openScreen,
  settle,
  type Theme,
  test,
} from "./support.ts";

const WCAG_TAGS: readonly string[] = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
];

const THEMES: readonly Theme[] = ["light", "dark"];
const MODES: readonly Mode[] = ["normal", "empty"];

/**
 * 通った要素も違反の要素も無い画面で、「要確認」のコントラストとして許す件数の上限。
 * 実画面にはサイドバーと見出しの文字があるのに、通った要素も違反の要素も無ければ、画面全体が測れていない。
 * 4は、下の検査自身の確認(4件は許し、5件は拒む)と対にした許容の件数で、実画面の「要確認」の最大を根拠にしない。
 * 通った要素が無いのに「要確認」が4件を超えると、色の検査はほぼ何も決められていないと見なす。
 */
const MAX_PENDING_CONTRAST = 4;

/** 画面の経路(`/console/`の下)。 */
const SCREEN_PATHS: readonly string[] = [
  "",
  "?approval=1",
  "?approval=3",
  "?failure=2",
  "?notice=1",
  "items",
  "items?tab=requirements",
  "items/new",
  "items/new-pr-review",
  "items/7",
  "items/7?tab=design",
  "items/7/design",
  "system",
  "jobs",
  "jobs?tab=history",
  "jobs?tab=schedules",
  // 起動の図。poll_issuesは起動するflowが1つなので、初めから開いた状態で検査する。
  "jobs/origins/poll_prs",
  "jobs/origins/poll_issues",
  "jobs/origins/poll_dependabot",
  // self_updateは、implement、pr_review、pr_fixがPR経由の破線でつながる図。
  "jobs/origins/self_update",
  "jobs/flows/implement",
  "jobs/flows/pr_review",
  "jobs/flows/pr_fix",
];

/** 見出しを1つずつ開いて検査する、起動の図の経路。開いたときだけ描かれる要素を検査するため。 */
const ORIGIN_PATHS: readonly string[] = [
  "jobs/origins/poll_prs",
  "jobs/origins/poll_issues",
  "jobs/origins/self_update",
];

/** 起動の図が、図でなく一覧で出る幅(px)。 */
const LIST_WIDTH = 500;

type Audit = {
  /** 違反を、規則、影響、要素の数と最初の要素で1行にしたもの。差分で原因を辿れるようにする。 */
  readonly violations: readonly string[];
  /** 通った規則が1つ以上あるか。偽なら、検査が何も測れていない。 */
  readonly checked: boolean;
  /** 文字のコントラストが測られたか。偽なら、色の検査が何も測れていない。 */
  readonly contrastMeasured: boolean;
  /** htmlの`data-theme`。配色を決める。 */
  readonly theme: string | null;
  /** htmlの`data-theme-preference`。保存した選択。 */
  readonly preference: string | null;
};

/** 画面をaxeにかけ、結果を要約する。「要確認」のコントラストの件数は、出力とレポートに残す。 */
async function auditOf(page: Page): Promise<Audit> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .analyze();
  const contrastNodes = (items: typeof results.incomplete): number =>
    items
      .filter((item) => item.id === "color-contrast")
      .reduce((sum, item) => sum + item.nodes.length, 0);
  const pending = contrastNodes(results.incomplete);
  // 通った、または違反になった要素が1つ以上あれば、測れている。
  // どちらも無いときは、「要確認」が1件以上、上限までなら、測ろうとはしたと見なす。
  const decided =
    contrastNodes(results.passes) + contrastNodes(results.violations);
  const contrastMeasured =
    decided > 0 || (pending > 0 && pending <= MAX_PENDING_CONTRAST);
  if (pending > 0) {
    const note = `color-contrast incomplete: ${pending} node(s) at ${page.url()}`;
    test.info().annotations.push({ type: "incomplete", description: note });
    console.log(note);
  }
  const attribute = (name: string) => page.locator("html").getAttribute(name);
  return {
    violations: results.violations.map((violation) => {
      const first = violation.nodes[0];
      const target = first === undefined ? "" : first.target.join(" ");
      return `${violation.id} (${violation.impact ?? "n/a"}) x${violation.nodes.length}: ${target}`;
    }),
    checked: results.passes.length > 0,
    contrastMeasured,
    theme: await attribute("data-theme"),
    preference: await attribute("data-theme-preference"),
  };
}

/** 違反が0件で、検査が測れていて、テーマが意図どおりの状態。 */
function clean(theme: Theme): Audit {
  return {
    violations: [],
    checked: true,
    contrastMeasured: true,
    theme,
    preference: theme,
  };
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test.describe(`screens (${theme}, ${mode})`, () => {
      test.use({ theme, mode });
      for (const path of SCREEN_PATHS) {
        test(`/console/${path} has no violations`, async ({ page }) => {
          await openScreen(page, path);

          expect(await auditOf(page)).toEqual(clean(theme));
        });
      }

      for (const path of ORIGIN_PATHS) {
        test(`/console/${path} has no violations while each flow is opened in turn`, async ({
          page,
        }) => {
          await openScreen(page, path);
          const headings = page.getByRole("button", { name: /のステップ$/ });
          const audits: Audit[] = [];
          for (let index = 0; index < (await headings.count()); index += 1) {
            const heading = headings.nth(index);
            if ((await heading.getAttribute("aria-expanded")) === "false") {
              await heading.click();
            }
            await expect(heading).toHaveAttribute("aria-expanded", "true");
            audits.push(await auditOf(page));
          }

          expect(audits).toEqual(
            Array.from({ length: audits.length }, () => clean(theme)),
          );
        });

        test(`/console/${path} has no violations in the list while each flow is opened in turn`, async ({
          page,
        }) => {
          await page.setViewportSize({ width: LIST_WIDTH, height: 800 });
          await openScreen(page, path);
          const summaries = page.locator("details > summary");
          const audits: Audit[] = [await auditOf(page)];
          for (let index = 0; index < (await summaries.count()); index += 1) {
            const details = summaries.nth(index).locator("..");
            if ((await details.getAttribute("open")) === null) {
              await summaries.nth(index).click();
            }
            await expect(details).toHaveAttribute("open", "");
            audits.push(await auditOf(page));
          }

          expect(audits).toEqual(
            Array.from({ length: audits.length }, () => clean(theme)),
          );
        });
      }
    });

    // 投入の2画面は、入力の誤りや進め方の選択で見た目が変わる。操作で出せる状態も検査する。
    test.describe(`intake forms (${theme}, ${mode})`, () => {
      // 本文は画面の中でスクロールする。画面の外の文字は、axe-coreが背景を決められず、色が測られない。
      // フォームの全体が収まる高さにして、すべての文字の色を測る。
      test.use({ theme, mode, viewport: { width: 1280, height: 2400 } });
      for (const state of INTAKE_STATES) {
        test(`${state.name} has no violations`, async ({ page }) => {
          await openScreen(page, state.path);
          await state.prepare(page);

          expect(await auditOf(page)).toEqual(clean(theme));
        });
      }
    });
  }

  test.describe(`dialogs (${theme})`, () => {
    test.use({ theme, mode: "normal" });

    test("the command palette has no violations", async ({ page }) => {
      await openScreen(page, "");
      await page.keyboard.press("ControlOrMeta+K");
      await expect(
        page.locator("dialog[data-command-palette][open]"),
      ).toBeVisible();

      expect(await auditOf(page)).toEqual(clean(theme));
    });

    test("the shortcut help has no violations", async ({ page }) => {
      await openScreen(page, "");
      await page.getByRole("button", { name: "ショートカット" }).click();
      await expect(page.locator("dialog[open]")).toBeVisible();

      expect(await auditOf(page)).toEqual(clean(theme));
    });

    test("the retry confirmation has no violations", async ({ page }) => {
      await openScreen(page, "?failure=2");
      await page.getByRole("button", { name: "再実行" }).click();
      await expect(page.locator("dialog[open]")).toBeVisible();
      await settle(page);

      expect(await auditOf(page)).toEqual(clean(theme));
    });
  });
}

// 検査自身の確認。違反を埋めた固定のページで、画面の検査と同じ設定のaxeが違反を返す。
// ここが通らないとき、画面の「違反なし」は何も意味しない。
test.describe("the axe check itself", () => {
  const PAGE_HEAD =
    '<!doctype html><html lang="ja"><head><title>canary</title></head>';

  /** 背景に画像があり、axeが色を決められない(要確認になる)段落を、count個並べたページ。 */
  const pendingPage = (count: number): string =>
    `${PAGE_HEAD}<body><main>${'<p style="background-image:linear-gradient(#ffffff,#000000);color:#888888">gradient</p>'.repeat(count)}</main></body></html>`;

  test("reports an image without alternative text", async ({ page }) => {
    await page.setContent(
      `${PAGE_HEAD}<body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>`,
    );

    const { violations } = await auditOf(page);

    expect(violations.some((line) => line.startsWith("image-alt"))).toBe(true);
  });

  test("reports text with low contrast", async ({ page }) => {
    await page.setContent(
      `${PAGE_HEAD}<body><main><p style="color:#777777;background:#888888">low contrast</p></main></body></html>`,
    );

    const { violations } = await auditOf(page);

    expect(violations.some((line) => line.startsWith("color-contrast"))).toBe(
      true,
    );
  });

  test("measures text with low contrast", async ({ page }) => {
    await page.setContent(
      `${PAGE_HEAD}<body><main><p style="color:#777777;background:#888888">low contrast</p></main></body></html>`,
    );

    const { contrastMeasured } = await auditOf(page);

    expect(contrastMeasured).toBe(true);
  });

  test("does not count a page without text as measured", async ({ page }) => {
    await page.setContent(
      `${PAGE_HEAD}<body><main><div></div></main></body></html>`,
    );

    const { contrastMeasured } = await auditOf(page);

    expect(contrastMeasured).toBe(false);
  });

  test("accepts a page whose text is only pending, within the limit", async ({
    page,
  }) => {
    await page.setContent(pendingPage(4));

    const { contrastMeasured } = await auditOf(page);

    expect(contrastMeasured).toBe(true);
  });

  test("rejects a page whose text is only pending, over the limit", async ({
    page,
  }) => {
    await page.setContent(pendingPage(5));

    const { contrastMeasured } = await auditOf(page);

    expect(contrastMeasured).toBe(false);
  });
});
