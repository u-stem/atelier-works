// Consoleの画面の表示の原則(`docs/console-display.md`)のうち、ソースの文字列で確かめられる2つを固定する。
// - 件数つきの見出しを、同じ画面のタブの名前と重ねない。件数はタブの名前が持つ。
// - 取得の時刻は、画面の見出しの「最終更新」だけが出す。節や帯に、別の取得時刻を足さない。
// 加えて、要対応の件数をバッジとメニューのボタン以外の画面の文字列に出さない。
// 検査の正規表現が、違反の例を捕まえることも、このファイルが確かめる。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { ITEM_DETAIL_TABS } from "../../console/src/lib/itemDetailView.ts";
import { ITEMS_TABS } from "../../console/src/lib/itemsTabs.ts";
import { JOBS_TABS } from "../../console/src/lib/jobsTabs.ts";
import { REPORTS_TABS } from "../../console/src/lib/reportsTabs.ts";
import { SYSTEM_TABS } from "../../console/src/lib/systemTabs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** コメントを除いたソース。コメントの中の説明の語は、検査の対象にしない。 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

// 数の表記。数字か、テンプレートの埋め込みである。
const COUNT = String.raw`(?:\$\{[^}]*\}|\d+)\s*件`;
// 語と数の間に許す、引用符と数を含まない文字。「要件定義がある作業項目 」のような言い回しを拾う。
const GAP = String.raw`[^"'\x60\n\d$]{0,12}`;

/** タブの名前に、件数を添えた見出しの文字列を含む行。タブの名前が件数を持つので、本体では繰り返さない。 */
function countedTabHeadings(
  source: string,
  tabLabels: readonly string[],
): string[] {
  const alternatives = tabLabels.join("|");
  const before = new RegExp(`(?:${alternatives})${GAP}${COUNT}`);
  const after = new RegExp(`${COUNT}${GAP}(?:${alternatives})`);
  return codeOf(source)
    .split("\n")
    .filter((line) => before.test(line) || after.test(line))
    .map((line) => line.trim());
}

// 取得の時刻の前置き。行の出来事の時刻(「失敗」「発生」「更新」「作成」など)は含めない。
const FETCH_TIME_PREFIX =
  /prefix=\{?["'\x60](?:最終取得|最終更新|取得)\s*["'\x60]/;

/** 取得の時刻を表す前置きを持つ行、または「最終取得」の語を含む行。 */
function fetchTimeDisplays(source: string): string[] {
  return codeOf(source)
    .split("\n")
    .filter((line) => FETCH_TIME_PREFIX.test(line) || line.includes("最終取得"))
    .map((line) => line.trim());
}

/** 要対応の件数を文字列に出す行。件数はサイドバーのバッジが持つ。 */
function actionableCounts(source: string): string[] {
  const pattern = new RegExp(`要対応${GAP}${COUNT}`);
  return codeOf(source)
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
}

const LABELS = {
  items: [...ITEMS_TABS, ...ITEM_DETAIL_TABS].map((tab) => tab.label),
  reports: REPORTS_TABS.tabs.map((tab) => tab.label),
  system: SYSTEM_TABS.tabs.map((tab) => tab.label),
  jobs: JOBS_TABS.tabs.map((tab) => tab.label),
};

describe("countedTabHeadings", () => {
  test("catches a heading that repeats the tab name with its count", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 検査の入力にするソースの文字列である。
    const source = "const text = `要件定義がある作業項目 ${rows.length}件`;";

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(1);
  });

  test("catches a count written before the tab name", () => {
    const source = 'const text = "3件の監査レポート";';

    expect(countedTabHeadings(source, ["監査レポート"])).toHaveLength(1);
  });

  test("passes a sentence that only mentions the tab name", () => {
    const source = 'const text = "要件定義書が見つかりません";';

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(0);
  });

  test("passes a count of something else on the same line", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 検査の入力にするソースの文字列である。
    const source = "const text = `履歴を表示(${notices.length}件)`;";

    expect(countedTabHeadings(source, ["状態", "設定"])).toHaveLength(0);
  });

  test("passes a comment that mentions the tab name and a count", () => {
    const source = "// 要件定義書1件の本文を出す。";

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(0);
  });
});

describe("fetchTimeDisplays", () => {
  test("catches a section time labeled as a fetch", () => {
    const source = '<TimeText iso={at} now={now} prefix="取得 " />';

    expect(fetchTimeDisplays(source)).toHaveLength(1);
  });

  test("catches a band time labeled as the last fetch", () => {
    const source = '<TimeText iso={at} now={now} prefix="最終取得 " />';

    expect(fetchTimeDisplays(source)).toHaveLength(1);
  });

  test("catches a second last-update time outside the page header", () => {
    const source = '<TimeText iso={at} now={now} prefix="最終更新 " />';

    expect(fetchTimeDisplays(source)).toHaveLength(1);
  });

  test("catches the last-fetch word in a string", () => {
    const source = 'const text = "最終取得: たった今";';

    expect(fetchTimeDisplays(source)).toHaveLength(1);
  });

  test("passes the time of an event on a row", () => {
    const source = '<TimeText iso={row.occurredAt} now={now} prefix="失敗 " />';

    expect(fetchTimeDisplays(source)).toHaveLength(0);
  });

  test("passes a comment that explains the page header", () => {
    const source = "// 取得の時刻は出さない。見出しの「最終取得」が示す。";

    expect(fetchTimeDisplays(source)).toHaveLength(0);
  });
});

describe("actionableCounts", () => {
  test("catches an actionable count in a string", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 検査の入力にするソースの文字列である。
    const source = "const text = `要対応${badge}件`;";

    expect(actionableCounts(source)).toHaveLength(1);
  });

  test("passes a string that names the tab without a count", () => {
    const source = 'const text = "要対応の画面を開く";';

    expect(actionableCounts(source)).toHaveLength(0);
  });
});

async function sourcesOf(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(ROOT)) {
    if (!/\.test\.tsx?$/.test(file)) found.push(file);
  }
  return found.sort();
}

async function violations(
  files: readonly string[],
  find: (source: string) => string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const source = await Bun.file(`${ROOT}${file}`).text();
    for (const line of find(source)) found.push(`${file}: ${line}`);
  }
  return found;
}

const SCREEN_FILES = {
  items: await sourcesOf("console/src/screens/items/**/*.{ts,tsx}"),
  reports: await sourcesOf("console/src/screens/reports/**/*.{ts,tsx}"),
  system: await sourcesOf("console/src/screens/system/**/*.{ts,tsx}"),
  jobs: await sourcesOf("console/src/screens/jobs/**/*.{ts,tsx}"),
};

const SCREEN_NAMES: readonly (keyof typeof SCREEN_FILES)[] = [
  "items",
  "reports",
  "system",
  "jobs",
];

const ALL_SCREEN_FILES = await sourcesOf("console/src/screens/**/*.{ts,tsx}");

// 取得の時刻を出してよいのは、画面の見出しだけである。
const DISPLAY_FILES = [
  ...ALL_SCREEN_FILES,
  ...(await sourcesOf("console/src/components/*.tsx")),
  ...(await sourcesOf("console/src/lib/*.ts")),
  ...(await sourcesOf("console/src/app/*.{ts,tsx}")),
].filter((file) => file !== "console/src/app/PageHeader.tsx");

describe("the screens", () => {
  test("find the screen files to scan", () => {
    expect(Object.values(SCREEN_FILES).every((files) => files.length > 0)).toBe(
      true,
    );
  });

  for (const screen of SCREEN_NAMES) {
    test(`${screen} bodies do not repeat a tab name with its count`, async () => {
      expect(
        await violations(SCREEN_FILES[screen], (source) =>
          countedTabHeadings(source, LABELS[screen]),
        ),
      ).toEqual([]);
    });
  }

  test("show no fetch time outside the page header", async () => {
    expect(await violations(DISPLAY_FILES, fetchTimeDisplays)).toEqual([]);
  });

  test("show no actionable count in a screen string", async () => {
    expect(await violations(ALL_SCREEN_FILES, actionableCounts)).toEqual([]);
  });
});
