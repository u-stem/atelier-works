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
  "?approval=4",
  "?approval=9",
  "?failure=2",
  "?notice=1",
  "items",
  "items?tab=requirements",
  "items/new",
  "items/new-pr-review",
  "items/7",
  "items/7?tab=design",
  "items/7/design",
  "items/7/requirements",
  "system",
  "system?tab=config",
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

/** 本文を「Markdownの文字」に切り替えて検査する経路。承認画面の要件定義を含む。 */
const TEXT_MODE_PATHS: readonly string[] = [
  "items/7/requirements",
  "?approval=1",
  "items/7/design",
];

/**
 * 原文を既定にし、プレビューを選んで検査する承認画面の経路。
 * `group`は、プレビューの選択肢を含む切り替えの名前。画面にはほかの切り替えもあるので、名前で絞る。
 */
const PREVIEW_PATHS: readonly { path: string; group: string }[] = [
  { path: "?approval=1", group: "取り込み時点のIssueの表示の形式" },
  { path: "?approval=4", group: "提案の本文の表示の形式" },
  { path: "?approval=3", group: "設計書の表示の形式" },
];

/** 見出しを1つずつ開いて検査する、起動の図の経路。開いたときだけ描かれる要素を検査するため。 */
const ORIGIN_PATHS: readonly string[] = [
  "jobs/origins/poll_prs",
  "jobs/origins/poll_issues",
  "jobs/origins/self_update",
];

/** 起動の図が、図でなく一覧で出る幅(px)。 */
const LIST_WIDTH = 500;

/**
 * 設定タブの表の意味を確かめる幅(px)。
 * 広い幅は表のまま、狭い幅は項目ごとに縦に積む。縦に積む幅でも、表の意味(役割)が残ることを確かめる。
 */
const CONFIG_STRUCTURE_WIDTHS: readonly number[] = [1280, 320];

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

/** 縞を見分けられる輝度比の下限。GitHubの表の縞はおよそ1.06である。 */
const MIN_STRIPE_RATIO = 1.05;

/** 通常の大きさの文字に求める輝度比の下限(WCAG AA)。 */
const MIN_TEXT_RATIO = 4.5;

/** 表の枠の中の要素。 */
const TABLE_FRAME = "section[aria-label='表']";

/** sRGBの1成分を、輝度の計算のために線形にする。 */
function linearChannel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** 2色の輝度比(WCAGの相対輝度)。1以上で、色が近いほど1に近い。 */
function luminanceRatio(a: readonly number[], b: readonly number[]): number {
  const luminance = ([red = 0, green = 0, blue = 0]: readonly number[]) =>
    0.2126 * linearChannel(red) +
    0.7152 * linearChannel(green) +
    0.0722 * linearChannel(blue);
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * 要素の左上の少し内側の、画面に描かれた色を読む。
 * 縞は半透明の重ね塗りなので、計算された背景色ではなく、描かれた画素を測る。
 */
async function paintedColor(page: Page, selector: string): Promise<number[]> {
  const target = page.locator(selector).first();
  await target.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error(`no box for ${selector}`);
  }
  const shot = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ shot, x, y }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${shot}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("no 2d context");
      }
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(x, y, 1, 1).data);
    },
    { shot, x: Math.round(box.x + 4), y: Math.round(box.y + 4) },
  );
}

/**
 * 要素の文字色を、sRGBの成分で読む。
 * 計算された色はoklchなどで返ることがあるので、canvasに塗って画素を読み、形式をそろえる。
 */
async function textColor(page: Page, selector: string): Promise<number[]> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("no 2d context");
      }
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
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

  // 「Markdownの文字」は、本文がある状態(normal)だけで検査する。
  test.describe(`text mode (${theme})`, () => {
    test.use({ theme, mode: "normal" });
    for (const path of TEXT_MODE_PATHS) {
      test(`/console/${path} has no violations`, async ({ page }) => {
        await openScreen(page, path);
        const choice = page.getByRole("button", { name: "Markdownの文字" });
        await choice.click();
        await expect(choice).toHaveAttribute("aria-pressed", "true");

        expect(await auditOf(page)).toEqual(clean(theme));
      });
    }
  });

  // 承認画面のプレビューは、原文が既定の画面で選んだときだけ描かれる。本文がある状態(normal)だけで検査する。
  // 取り込み時点のIssueと提案は、プレビューを選ぶと原文の確認のチェックも出るので、それも検査に含まれる。
  // 設計書の本文も、GFMのタスクリストと脚注を含む固定データで検査する。
  test.describe(`preview of an approval (${theme})`, () => {
    test.use({ theme, mode: "normal" });
    for (const { path, group } of PREVIEW_PATHS) {
      test(`/console/${path} has no violations in the preview`, async ({
        page,
      }) => {
        await openScreen(page, path);
        const choice = page
          .getByRole("group", { name: group })
          .getByRole("button", { name: "プレビュー" });
        await choice.click();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("[data-preview]")).toBeVisible();
        // 検査が、GFMのタスクリストと脚注を含む本文に対して行われていることを確かめる。
        await expect(
          page.locator("[data-preview] input[type=checkbox]"),
        ).toHaveCount(2);
        await expect(
          page.locator("[data-preview] [data-footnotes]"),
        ).toHaveCount(1);

        expect(await auditOf(page)).toEqual(clean(theme));
      });
    }
  });

  // 表の縞は、見分けられる濃さで、ヘッダーの背景とも同化しない。
  test.describe(`table stripes (${theme})`, () => {
    test.use({ theme, mode: "normal" });
    for (const path of TEXT_MODE_PATHS) {
      test(`/console/${path} shows the stripe of the second row`, async ({
        page,
      }) => {
        await openScreen(page, path);
        const first = await paintedColor(
          page,
          `${TABLE_FRAME} tbody tr:nth-child(1) td`,
        );
        const second = await paintedColor(
          page,
          `${TABLE_FRAME} tbody tr:nth-child(2) td`,
        );

        expect(luminanceRatio(first, second)).toBeGreaterThanOrEqual(
          MIN_STRIPE_RATIO,
        );
      });

      test(`/console/${path} tells the header from the stripe`, async ({
        page,
      }) => {
        await openScreen(page, path);
        const header = await paintedColor(page, `${TABLE_FRAME} th`);
        const second = await paintedColor(
          page,
          `${TABLE_FRAME} tbody tr:nth-child(2) td`,
        );

        expect(luminanceRatio(header, second)).toBeGreaterThanOrEqual(
          MIN_STRIPE_RATIO,
        );
      });
    }
  });

  // 最初の縞の行にあるリンクとコード表記と、ヘッダーの文字の色を測る。画面の外の文字は色が測られないので、
  // 表の全体が収まる高さにして、縞の行の要素が「通った」になり、「要確認」が残らないことを確かめる。
  test.describe(`text on the table stripes (${theme})`, () => {
    test.use({
      theme,
      mode: "normal",
      viewport: { width: 1280, height: 2400 },
    });
    for (const path of TEXT_MODE_PATHS) {
      const measured = [
        {
          name: "a on a striped row",
          selector: `${TABLE_FRAME} tbody tr:nth-child(2) a`,
        },
        {
          name: "code on a striped row",
          selector: `${TABLE_FRAME} tbody tr:nth-child(2) code`,
        },
      ];
      for (const { name, selector } of measured) {
        test(`/console/${path} measures ${name}`, async ({ page }) => {
          await openScreen(page, path);
          // 承認画面は、本文が画面の中でスクロールする。測る要素を枠の中へ入れる。
          await page
            .locator(selector)
            .first()
            .evaluate((target) => target.scrollIntoView({ block: "center" }));
          const results = await new AxeBuilder({ page })
            .withRules(["color-contrast"])
            .include(selector)
            .analyze();

          expect({
            violations: results.violations.length,
            incomplete: results.incomplete.length,
            measured: results.passes.length > 0,
          }).toEqual({ violations: 0, incomplete: 0, measured: true });
        });
      }

      // 罫線を畳んだ表の見出しは、axe-coreが背景を決められず、「要確認」になる。
      // 描かれた背景の色と、文字色の輝度比で測る。
      test(`/console/${path} keeps the header text readable`, async ({
        page,
      }) => {
        await openScreen(page, path);
        const background = await paintedColor(page, `${TABLE_FRAME} th`);
        const text = await textColor(page, `${TABLE_FRAME} th`);

        expect(luminanceRatio(text, background)).toBeGreaterThanOrEqual(
          MIN_TEXT_RATIO,
        );
      });
    }
  });

  // 設定タブの表は、見出しで名付けられ、列見出しと行見出しを持つ。axeの規則では、この構造の崩れを捕まえられない。
  // 表の中の表(オブジェクトの配列の値)は名前を持たないので、名前のある表だけを数える。
  // 見た目だけを変える変更が表の役割を落とすことがあるので、広い幅と狭い幅の両方で確かめる。
  for (const width of CONFIG_STRUCTURE_WIDTHS) {
    test.describe(`config tab structure (${theme}, ${width}px)`, () => {
      test.use({
        theme,
        mode: "normal",
        viewport: { width, height: 800 },
      });

      /** 名前のある表ごとに、直下の指定の役割の要素の数を数える。 */
      const countsByNamedTable = async (
        page: Page,
        role: "columnheader" | "rowheader",
      ): Promise<number[]> => {
        const tables = page.getByRole("table", { name: /\S/ });
        const counts: number[] = [];
        for (let index = 0; index < (await tables.count()); index += 1) {
          counts.push(await tables.nth(index).getByRole(role).count());
        }
        return counts;
      };

      test("has named tables", async ({ page }) => {
        await openScreen(page, "system?tab=config");

        expect(
          await page.getByRole("table", { name: /\S/ }).count(),
        ).toBeGreaterThan(0);
      });

      test("gives every named table column headers", async ({ page }) => {
        await openScreen(page, "system?tab=config");

        const counts = await countsByNamedTable(page, "columnheader");

        expect(counts.filter((count) => count === 0)).toEqual([]);
      });

      test("gives every named table row headers", async ({ page }) => {
        await openScreen(page, "system?tab=config");

        const counts = await countsByNamedTable(page, "rowheader");

        expect(counts.filter((count) => count === 0)).toEqual([]);
      });
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
