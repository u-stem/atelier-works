// Consoleのジョブの画面が、ログ、結果、引数、失敗の原因、設定の値を、テキストのノードとしてだけ描くことを固定する。
// これらの文字列は、defaultのworkerで動いたscriptの出力や、Issueに由来する値を含みうる。
// Markdown、HTML、ANSIの解釈、自動のリンクを使うと、描画の経路から画面に害が及ぶ。
// 部品のソースにその経路が無いことを、ここで確かめる。
// 見えない文字と並びを入れ替える文字は、無害化の部品(`console/src/lib/safeText.ts`)が代替文字にする。
// 部品を通さない描画が無いことは、次の3つで確かめる。
// - 描画の部品が、無害化の部品を通さずに`displayableIssueText`を呼ばない。
// - サーバー由来の項目を、JSXにそのまま埋め込まない。
// - すべての項目に見えない文字を入れて描き、残らないことを、`safeTextCoverage.test.tsx`が確かめる。
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

const JOB_SCREENS = await sourcesOf("console/src/screens/jobs/*.{ts,tsx}");

const RENDERERS = [
  ...JOB_SCREENS,
  "console/src/screens/system/ConfigSection.tsx",
  "console/src/lib/jobsView.ts",
];

/** サーバーの文字列を画面に出す部品。無害化の部品を取り込んでいなければならない。 */
const SAFE_TEXT_USERS = [
  "console/src/screens/jobs/JobDetailParts.tsx",
  "console/src/screens/jobs/JobDetailScreen.tsx",
  "console/src/screens/jobs/JobHistory.tsx",
  "console/src/screens/jobs/JobRows.tsx",
  "console/src/screens/jobs/ScheduleList.tsx",
  "console/src/screens/system/ConfigSection.tsx",
];

async function textOf(file: string): Promise<string> {
  return Bun.file(`${ROOT}${file}`).text();
}

/**
 * コメントを除いたソース。コメントの中の説明の語は、禁止の対象にしない。
 * 行のコメントは、行頭か空白の後の`//`だけを外す。`"https://x"`や`/a\/\/b/`の中の`//`は、コードなので残す。
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `from`で始まり`to`の手前までの部分。`to`が無ければ末尾まで。見つからなければ空文字。 */
function between(code: string, from: string, to?: string): string {
  const start = code.indexOf(from);
  if (start < 0) return "";
  const rest = code.slice(start);
  const end = to === undefined ? -1 : rest.indexOf(to, from.length);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 出力の節に置かないリンクのタグ。タグ名の後ろが空白、`>`、`/`のどれかなら当たる。
 * 属性が複数行に折れた`<Link\n  to=...`も捕まえる。
 */
const LINK_TAG = /<(a|Link|NavLink|JobLink|WindmillJobLink)(\s|>|\/)/;

/** サーバー由来の文字列の項目名。 */
const FIELDS =
  "script_path|schedule_path|timezone|schedule|error|reason|result_error|key|value|text|path|step|id|type|name";

/** 項目名だけの式。`item.key`のように、呼び出しや演算を含まない。 */
const FIELD_EXPRESSION = String.raw`\{\s*[A-Za-z_][\w.]*\.(${FIELDS})\s*\}`;

/**
 * サーバー由来の文字列の項目を、JSXにそのまま埋め込む形。
 * 子の位置の式(`<dt>{item.key}</dt>`)と、画面に出る属性(`title`、`subtitle`、`label`、`aria-label`、`alt`)に当たる。
 * `safeText(...)`の呼び出しと、`key`や`error`のような値を渡す属性には当たらない。
 */
const RAW_FIELD_IN_JSX = new RegExp(
  String.raw`(?<!=)${FIELD_EXPRESSION}|\b(title|subtitle|label|aria-label|alt)=${FIELD_EXPRESSION}`,
);

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
    pattern: /linkif|autolink|urlRegex/i,
    sample: 'import linkifyHtml from "linkify-html";',
  },
  {
    name: "a URL in the source",
    pattern: /https?\??:\\?\/\\?\/|www\./i,
    sample: 'const base = "https://example.com";',
  },
  {
    name: "a URL pattern in a regular expression literal",
    pattern: /https?\??:\\?\/\\?\/|www\./i,
    sample: "const re = /https?:\\/\\/\\S+/;",
  },
  {
    name: "a www host",
    pattern: /https?\??:\\?\/\\?\/|www\./i,
    sample: 'const host = "www.example.com";',
  },
  {
    name: "a URL pattern built with RegExp",
    pattern: /new RegExp\([^)]*(https?|www)/i,
    sample: 'const re = new RegExp("https?:" + rest);',
  },
  {
    name: "the code span splitter",
    pattern: /codeSpans/,
    sample: 'import { splitCodeSpans } from "../../lib/codeSpans.ts";',
  },
  {
    name: "a direct call of displayableIssueText, which skips the sanitizing part",
    pattern: /displayableIssueText/,
    sample: "const t = displayableIssueText(raw).text;",
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

    test("does not embed a field of the server as it is", async () => {
      expect(codeOf(await textOf(file))).not.toMatch(RAW_FIELD_IN_JSX);
    });
  });
});

describe("the sanitizing part", () => {
  test("wraps displayableIssueText, so the renderers have one way in", async () => {
    expect(codeOf(await textOf("console/src/lib/safeText.ts"))).toContain(
      "displayableIssueText(",
    );
  });

  test.each(SAFE_TEXT_USERS)("is imported by %s", async (file) => {
    expect(codeOf(await textOf(file))).toMatch(
      /import\s*\{[^}]*\bsafeText\b[^}]*\}\s*from\s*"[./]*\/lib\/safeText\.ts"/,
    );
  });

  test("is exercised on every field by the coverage test", async () => {
    expect(
      await Bun.file(
        `${ROOT}console/src/screens/jobs/safeTextCoverage.test.tsx`,
      ).exists(),
    ).toBe(true);
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

  test("the comment stripper keeps the slashes of a regular expression literal", () => {
    expect(codeOf("const re = /a\\/\\/b/;")).toContain("a\\/\\/b");
  });

  test("the comment stripper drops the words of a comment", () => {
    expect(codeOf("/* innerHTML */ const a = 1;")).not.toContain("innerHTML");
  });

  test("the comment stripper drops a line comment after code", () => {
    expect(codeOf("const a = 1; // innerHTML")).not.toContain("innerHTML");
  });

  test.each([
    ["a field of an item", "<dt>{item.key}</dt>"],
    ["a field of a job", "<span>{job.script_path}</span>"],
    ["a title attribute", "<h1 title={job.script_path}>x</h1>"],
    ["a subtitle attribute", "<PageHeader subtitle={job.id} />"],
    ["a nested field", "<p>{failures.reason}</p>"],
    ["a field with spaces", "<p>{ row.error }</p>"],
  ])("the raw field pattern catches %s", (_name, sample) => {
    expect(sample).toMatch(RAW_FIELD_IN_JSX);
  });

  test.each([
    ["a wrapped field", "<dt>{safeText(item.key)}</dt>"],
    ["a React key", "<li key={item.key}>x</li>"],
    ["a prop that passes an object", "<Alert error={query.error} />"],
    ["a prop that passes an id", "<Link jobId={job.id} />"],
    ["a field that is not text", "<span>{step.iterations}</span>"],
    ["a local name", "<span>{label}</span>"],
  ])("the raw field pattern leaves %s alone", (_name, sample) => {
    expect(sample).not.toMatch(RAW_FIELD_IN_JSX);
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

  test("the section finder reads up to the next section", () => {
    const code =
      "export function A() { return <Link to=x/>; }\nexport function B() {}";
    expect(between(code, "export function A", "export function B")).toMatch(
      LINK_TAG,
    );
  });

  test("the section finder stops before the next section", () => {
    const code =
      "export function A() {}\nexport function B() { return <a>x</a>; }";
    expect(between(code, "export function A", "export function B")).not.toMatch(
      LINK_TAG,
    );
  });

  test("the section finder gives an empty text for a name that is not there", () => {
    expect(between("const a = 1;", "export function A")).toBe("");
  });
});

/**
 * 保存された原因は、ジョブの詳細へのリンク(`JobLink`)を持つ。
 * `JobLink`はUUIDの形のidだけをリンクにするので許す。生のリンクは置かない。
 */
const RAW_LINK_TAG = /<(a|Link|NavLink)(\s|>|\/)/;

/** 出力を描く節。リンクを置かない。保存された原因は、生のリンクだけを置かない。 */
const SECTIONS: readonly (readonly [string, string, string, string?])[] = [
  [
    "the log and the result",
    "console/src/screens/jobs/JobDetailParts.tsx",
    "export function OutputSection",
    "export function FailureCauses",
  ],
  [
    "the arguments",
    "console/src/screens/jobs/JobDetailParts.tsx",
    "export function ArgList",
    "export function StepList",
  ],
  [
    "the saved causes",
    "console/src/screens/jobs/JobDetailParts.tsx",
    "export function FailureCauses",
  ],
  [
    "the values of the config",
    "console/src/screens/system/ConfigSection.tsx",
    "function ConfigValue",
    "function ConfigBody",
  ],
];

describe.each(SECTIONS)("the part that draws %s", (_name, file, from, to) => {
  const section = async () => between(codeOf(await textOf(file)), from, to);

  test("is found in the source", async () => {
    expect((await section()).length).toBeGreaterThan(200);
  });

  test("does not draw a link", async () => {
    expect(await section()).not.toMatch(
      from === "export function FailureCauses" ? RAW_LINK_TAG : LINK_TAG,
    );
  });
});
