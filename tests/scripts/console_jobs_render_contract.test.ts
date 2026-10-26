// Consoleのジョブの画面が、ログ、結果、引数、失敗の原因、設定の値を、テキストのノードとしてだけ描くことを固定する。
// これらの文字列は、defaultのworkerで動いたscriptの出力や、Issueに由来する値を含みうる。
// Markdown、HTML、ANSIの解釈、自動のリンクを使うと、描画の経路から画面に害が及ぶ。
// 描画の結果は`console/src/screens/jobs/*.test.tsx`が確かめ、ここでは部品のソースに、その経路が無いことを確かめる。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = new URL("../../", import.meta.url).pathname;

async function sourcesOf(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(ROOT)) {
    if (!/\.test\.tsx?$/.test(file)) found.push(file);
  }
  return found.sort();
}

const RENDERERS = [
  ...(await sourcesOf("console/src/screens/jobs/*.{ts,tsx}")),
  "console/src/screens/system/ConfigSection.tsx",
  "console/src/lib/jobsView.ts",
];

async function textOf(file: string): Promise<string> {
  return Bun.file(`${ROOT}${file}`).text();
}

/** コメントを除いたソース。コメントの中の説明の語は、禁止の対象にしない。 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["innerHTML", /innerHTML/],
  ["outerHTML", /outerHTML/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["document.write", /document\.write/],
  ["the Markdown component", /components\/markdown|react-markdown/],
  ["a Markdown plugin", /remark|rehype|micromark/],
  ["an ANSI parser", /\bansi\b|ansi[-_]|ansiup|anser|ansicolor/i],
  ["an automatic linker", /linkif|autolink|urlRegex|https?:\/\//i],
  ["the code span splitter", /codeSpans/],
];

describe("the renderers of the job screens", () => {
  test("include the parts that draw the output", () => {
    expect(RENDERERS).toContain("console/src/screens/jobs/JobDetailParts.tsx");
  });

  test("include the config section", () => {
    expect(RENDERERS).toContain("console/src/screens/system/ConfigSection.tsx");
  });

  describe.each(RENDERERS)("%s", (file) => {
    test.each(FORBIDDEN)("does not use %s", async (_name, pattern) => {
      expect(codeOf(await textOf(file))).not.toMatch(pattern);
    });
  });
});

describe("the part that draws the log and the result", () => {
  test("passes the text through displayableIssueText", async () => {
    expect(
      codeOf(await textOf("console/src/screens/jobs/JobDetailParts.tsx")),
    ).toContain("displayableIssueText");
  });

  test("does not import a link component", async () => {
    const parts = codeOf(
      await textOf("console/src/screens/jobs/JobDetailParts.tsx"),
    );
    const output = parts.slice(parts.indexOf("export function OutputSection"));
    const body = output.slice(
      0,
      output.indexOf("export function FailureCauses"),
    );
    expect(body).not.toMatch(/<(a|Link|JobLink)[ >]/);
  });
});
