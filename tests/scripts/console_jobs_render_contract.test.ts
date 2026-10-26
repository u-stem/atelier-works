// Consoleのジョブの画面が、ログ、結果、引数、失敗の原因、設定の値を、テキストのノードとしてだけ描くことを固定する。
// これらの文字列は、defaultのworkerで動いたscriptの出力や、Issueに由来する値を含みうる。
// Markdown、HTML、ANSIの解釈、自動のリンクを使うと、描画の経路から画面に害が及ぶ。
// 部品のソースにその経路が無いことを、ここで確かめる。
// 見えない文字と並びを入れ替える文字が代替文字になることは、描画の結果を
// `console/src/screens/jobs/*.test.tsx`と`console/src/screens/system/ConfigSection.test.tsx`が確かめる。
// 検査の正規表現が、違反の例を捕まえることも、このファイルが確かめる。

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

/**
 * 出力の節に置かないリンクのタグ。タグ名の後ろが空白、`>`、`/`のどれかなら当たる。
 * 属性が複数行に折れた`<Link\\n  to=...`も捕まえる。
 */
const LINK_TAG = /<(a|Link|NavLink|JobLink|WindmillJobLink)(\s|>|\/)/;

type Forbidden = {
  readonly name: string;
  readonly pattern: RegExp;
  /** 違反の例。検査が空振りしていないことを確かめる。 */
  readonly sample: string;
};

const FORBIDDEN: readonly Forbidden[] = [
  { name: "innerHTML", pattern: /innerHTML/, sample: "el.innerHTML = x;" },
  { name: "outerHTML", pattern: /outerHTML/, sample: "el.outerHTML = x;" },
  {
    name: "insertAdjacentHTML",
    pattern: /insertAdjacentHTML/,
    sample: 'el.insertAdjacentHTML("beforeend", x);',
  },
  {
    name: "dangerouslySetInnerHTML",
    pattern: /dangerouslySetInnerHTML/,
    sample: "<div dangerouslySetInnerHTML={{ __html: x }} />",
  },
  {
    name: "document.write",
    pattern: /document\.write/,
    sample: "document.write(x);",
  },
  {
    name: "the Markdown component",
    pattern: /components\/markdown|react-markdown/,
    sample:
      'import { Markdown } from "../../components/markdown/Markdown.tsx";',
  },
  {
    name: "a Markdown plugin",
    pattern: /remark|rehype|micromark/,
    sample: 'import remarkGfm from "remark-gfm";',
  },
  {
    name: "an ANSI parser",
    pattern: /\bansi\b|ansi[-_]|ansiup|anser|ansicolor/i,
    sample: 'import Anser from "anser";',
  },
  {
    name: "an automatic linker",
    pattern: /linkif|autolink|urlRegex|https?:\/\//i,
    sample: 'const base = "https://example.com";',
  },
  {
    name: "the code span splitter",
    pattern: /codeSpans/,
    sample: 'import { splitCodeSpans } from "../../lib/codeSpans.ts";',
  },
];

describe("the renderers of the job screens", () => {
  test("include the parts that draw the output", () => {
    expect(RENDERERS).toContain("console/src/screens/jobs/JobDetailParts.tsx");
  });

  test("include the config section", () => {
    expect(RENDERERS).toContain("console/src/screens/system/ConfigSection.tsx");
  });

  describe.each(RENDERERS)("%s", (file) => {
    test.each(FORBIDDEN.map((f) => [f.name, f.pattern] as const))(
      "does not use %s",
      async (_name, pattern) => {
        expect(codeOf(await textOf(file))).not.toMatch(pattern);
      },
    );
  });
});

describe("the checks themselves", () => {
  test.each(FORBIDDEN.map((f) => [f.name, f.pattern, f.sample] as const))(
    "the check for %s catches a violation",
    (_name, pattern, sample) => {
      expect(codeOf(sample)).toMatch(pattern);
    },
  );

  test("the comment stripper keeps code that follows a URL in a string", () => {
    expect(codeOf('const u = "https://x"; // note')).toContain("https://x");
  });

  test("the comment stripper drops the words of a comment", () => {
    expect(codeOf("/* innerHTML */ const a = 1;")).not.toContain("innerHTML");
  });

  test.each([
    ["a tag whose attributes wrap", "<Link\n  to={path}\n>x</Link>"],
    ["a tag followed by a space", "<a href={x}>x</a>"],
    ["a tag that closes at once", "<a>x</a>"],
    ["a self closing tag", "<JobLink/>"],
    [
      "a job link whose attributes wrap",
      "<JobLink\n  jobId={id}\n  label={x}\n/>",
    ],
    ["a Windmill link", "<WindmillJobLink jobId={id} label={x} />"],
  ])("the link pattern catches %s", (_name, sample) => {
    expect(sample).toMatch(LINK_TAG);
  });

  test.each([
    ["a button", "<Button onClick={x}>x</Button>"],
    ["a tag that only starts like a link", "<Linked>x</Linked>"],
    ["an anchor-like name", "<abbr>x</abbr>"],
  ])("the link pattern leaves %s alone", (_name, sample) => {
    expect(sample).not.toMatch(LINK_TAG);
  });
});

describe("the part that draws the log and the result", () => {
  async function outputSection(): Promise<string> {
    const parts = codeOf(
      await textOf("console/src/screens/jobs/JobDetailParts.tsx"),
    );
    const from = parts.indexOf("export function OutputSection");
    const rest = parts.slice(from);
    return rest.slice(0, rest.indexOf("export function FailureCauses"));
  }

  test("is found in the source", async () => {
    expect((await outputSection()).length).toBeGreaterThan(200);
  });

  test("does not draw a link in the output", async () => {
    expect(await outputSection()).not.toMatch(LINK_TAG);
  });
});
