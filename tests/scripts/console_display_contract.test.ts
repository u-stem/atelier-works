// Consoleの画面の表示の原則(`docs/console-display.md`)のうち、ソースの文字列で確かめられる3つを固定する。
// - 件数つきの見出しを、同じ画面のタブの名前と重ねない。件数はタブの名前が持つ。
// - 取得の時刻は、画面の見出しの「最終更新」だけが出す。節や帯に、別の取得時刻を足さない。
// - 要対応の件数は、バッジとメニューのボタンの名前だけが持つ。
// 検査の正規表現が、違反の例を捕まえることも、このファイルが確かめる。
//
// 検出できる範囲は、ソースに文字列として書いた表示に限る。
// 定数や関数を経由して作った前置きや見出し、タグをまたいで並べた語と件数は、見つけられない。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { ITEM_DETAIL_TABS } from "../../console/src/lib/itemDetailView.ts";
import { ITEMS_TABS } from "../../console/src/lib/itemsTabs.ts";
import { JOBS_TABS } from "../../console/src/lib/jobsTabs.ts";
import { REPORTS_TABS } from "../../console/src/lib/reportsTabs.ts";
import { SYSTEM_TABS } from "../../console/src/lib/systemTabs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * コメントを除き、改行を1つの空白にしたソース。
 * コメントの中の説明の語は、検査の対象にしない。
 * 折り返したJSXの文字列も、1つの並びとして読む。
 */
function flatCodeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s*\n\s*/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 数の表記。数字、テンプレートの埋め込み、JSXの埋め込みである。
const COUNT = String.raw`(?:\$?\{[^}]*\}|\d+)\s*件`;
// 語と数の間に許す、引用符、数、タグ、埋め込みを含まない文字。「要件定義がある作業項目 」のような言い回しを拾う。
const GAP = String.raw`[^"'\x60\n\d$<>{}]{0,12}`;

/** タブの名前に、件数を添えた見出しの文字列。タブの名前が件数を持つので、本体では繰り返さない。 */
function countedTabHeadings(
  source: string,
  tabLabels: readonly string[],
): string[] {
  const alternatives = tabLabels.map(escapeRegExp).join("|");
  const before = new RegExp(`(?:${alternatives})${GAP}${COUNT}`, "g");
  const after = new RegExp(`${COUNT}${GAP}(?:${alternatives})`, "g");
  const code = flatCodeOf(source);
  return [...code.matchAll(before), ...code.matchAll(after)].map(
    (match) => match[0],
  );
}

// 取得の時刻の前置きと、「最終取得」の語。行の出来事の時刻(「失敗」「発生」「更新」「作成」など)は含めない。
const FETCH_TIME =
  /prefix=\{?["'\x60](?:最終取得|最終更新|取得)\s*["'\x60]|最終取得/g;

/** 取得の時刻を表す前置きと、「最終取得」の語。 */
function fetchTimeDisplays(source: string): string[] {
  return [...flatCodeOf(source).matchAll(FETCH_TIME)].map((match) => match[0]);
}

/** 要対応の件数を文字列に出した箇所。件数はサイドバーのバッジが持つ。 */
function actionableCounts(source: string): string[] {
  const pattern = new RegExp(`要対応${GAP}${COUNT}`, "g");
  return [...flatCodeOf(source).matchAll(pattern)].map((match) => match[0]);
}

const LABELS = {
  items: [...ITEMS_TABS, ...ITEM_DETAIL_TABS].map((tab) => tab.label),
  reports: REPORTS_TABS.tabs.map((tab) => tab.label),
  system: SYSTEM_TABS.tabs.map((tab) => tab.label),
  jobs: JOBS_TABS.tabs.map((tab) => tab.label),
};

// 画面を持たないファイル(lib、components、app)に使う名前。
// 「履歴」「設定」「状態」のような短い名前は、別の語の一部として現れて誤検知になるので、3字以上に限る。
const SHARED_LABELS = [...new Set(Object.values(LABELS).flat())].filter(
  (label) => label.length >= 3,
);

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

  test("catches a JSX count after the tab name", () => {
    const source = "<h2>要件定義{rows.length}件</h2>";

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(1);
  });

  test("catches a heading that the formatter wrapped over lines", () => {
    const source = "<h2>\n  要件定義がある作業項目\n  {rows.length}件\n</h2>";

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(1);
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

  test("passes a tab name next to a count in another element", () => {
    const source = "<h2>要件定義</h2>\n<p>{rows.length}件</p>";

    expect(countedTabHeadings(source, ["要件定義"])).toHaveLength(0);
  });

  test("treats regular expression characters in a name as plain text", () => {
    const source = 'const text = "A(B 3件";';

    expect(countedTabHeadings(source, ["A(B"])).toHaveLength(1);
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

  test("catches a prefix on its own line", () => {
    const source = '<TimeText\n  iso={at}\n  prefix="取得 "\n/>';

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

  test("catches an actionable count in JSX", () => {
    const source = "<p>要対応({badge}件)</p>";

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
  find: (source: string, file: string) => string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const source = await Bun.file(`${ROOT}${file}`).text();
    for (const text of find(source, file)) found.push(`${file}: ${text}`);
  }
  return found;
}

const SCREEN_NAMES = ["items", "reports", "system", "jobs"] as const;

const SCREEN_FILES = await sourcesOf("console/src/screens/**/*.{ts,tsx}");

// 画面の表示を作るファイルの全体。画面、部品(下位のディレクトリを含む)、表示の純関数、外枠、取り込みの帯である。
const DISPLAY_FILES = [
  ...SCREEN_FILES,
  ...(await sourcesOf("console/src/components/**/*.{ts,tsx}")),
  ...(await sourcesOf("console/src/lib/*.ts")),
  ...(await sourcesOf("console/src/app/*.{ts,tsx}")),
  ...(await sourcesOf("console/src/*.{ts,tsx}")),
];

/** ファイルに使うタブの名前。タブを持つ画面の下は画面のタブ、それ以外は3字以上の名前の全体。 */
function labelsFor(file: string): readonly string[] {
  for (const name of SCREEN_NAMES) {
    if (file.startsWith(`console/src/screens/${name}/`)) return LABELS[name];
  }
  return SHARED_LABELS;
}

describe("the screens", () => {
  test("find the files to scan", () => {
    expect(SCREEN_FILES.length > 0 && DISPLAY_FILES.length > 0).toBe(true);
  });

  test("scan every directory that holds a tabbed screen", () => {
    const dirs = SCREEN_NAMES.map((name) => `console/src/screens/${name}/`);

    expect(
      dirs.every((dir) => SCREEN_FILES.some((file) => file.startsWith(dir))),
    ).toBe(true);
  });

  test("define the tabs of tabbed screens only in the listed files", async () => {
    const files = await sourcesOf("console/src/**/*.{ts,tsx}");
    const defining: string[] = [];
    for (const file of files) {
      const source = await Bun.file(`${ROOT}${file}`).text();
      if (source.includes("TabSet<")) defining.push(file);
    }

    expect(defining).toEqual([
      "console/src/lib/itemsTabs.ts",
      "console/src/lib/jobsTabs.ts",
      "console/src/lib/reportsTabs.ts",
      "console/src/lib/systemTabs.ts",
      "console/src/lib/tabSet.ts",
    ]);
  });

  test("do not repeat a tab name with its count", async () => {
    expect(
      await violations(DISPLAY_FILES, (source, file) =>
        countedTabHeadings(source, labelsFor(file)),
      ),
    ).toEqual([]);
  });

  test("show no fetch time outside the page header", async () => {
    const files = DISPLAY_FILES.filter(
      (file) => file !== "console/src/app/PageHeader.tsx",
    );

    expect(await violations(files, fetchTimeDisplays)).toEqual([]);
  });

  test("show no actionable count outside the badge and the menu button", async () => {
    const files = DISPLAY_FILES.filter(
      (file) => file !== "console/src/lib/navigation.ts",
    );

    expect(await violations(files, actionableCounts)).toEqual([]);
  });
});
