import { describe, expect, test } from "bun:test";
import {
  createLinkResolver,
  htmlIds,
  indexDoc,
  type LinkResolver,
  lintDocLinks,
  resolveLinkTarget,
} from "../../scripts/lint-doc-links.ts";
import { parseMarkdown } from "../../scripts/markdown-tree.ts";

describe("resolveLinkTarget", () => {
  test("resolves a relative path from the document and decodes the anchor", () => {
    expect(
      resolveLinkTarget("docs/internals/a.md", "../b.md#%E6%AE%8B%E3%82%8B"),
    ).toEqual({
      path: "docs/b.md",
      anchor: "残る",
      directory: false,
      query: false,
    });
  });

  test("resolves an empty path to the document itself", () => {
    expect(resolveLinkTarget("docs/a.md", "#x")).toEqual({
      path: "docs/a.md",
      anchor: "x",
      directory: false,
      query: false,
    });
  });

  test("marks a path that ends with a slash as a directory", () => {
    expect(resolveLinkTarget("docs/a.md", "internals/")?.directory).toBe(true);
  });

  test("drops the query from the path and marks it", () => {
    expect(resolveLinkTarget("docs/a.md", "b.md?plain=1#L10")).toEqual({
      path: "docs/b.md",
      anchor: "L10",
      directory: false,
      query: true,
    });
  });

  test("returns undefined for an external URL", () => {
    expect(resolveLinkTarget("docs/a.md", "https://example.com/a.md#x")).toBe(
      undefined,
    );
  });

  test("returns undefined for a path that leaves the repository", () => {
    expect(resolveLinkTarget("docs/a.md", "../../x.md")).toBe(undefined);
  });
});

describe("htmlIds", () => {
  test("returns the id and the name of start tags in order", () => {
    expect(htmlIds('<a id="r-ab-01"></a><a name="x"></a>')).toEqual([
      "r-ab-01",
      "x",
    ]);
  });

  test("ignores a tag inside an HTML comment", () => {
    expect(htmlIds('<!-- <a id="r-ab-01"></a> -->')).toEqual([]);
  });
});

function anchorsOf(markdown: string): string[] {
  return [...indexDoc(markdown).anchors];
}

function targetsOf(markdown: string): string[] {
  return indexDoc(markdown).links.map((link) => link.target);
}

describe("indexDoc anchors", () => {
  test("collects headings of every level", () => {
    expect(anchorsOf("# 一\n\n## 二\n\n###### 六\n")).toEqual([
      "一",
      "二",
      "六",
    ]);
  });

  test("lowercases ASCII letters and joins words with hyphens", () => {
    expect(anchorsOf("## Check CI\n")).toEqual(["check-ci"]);
  });

  test("removes punctuation, symbols, and Japanese brackets", () => {
    expect(anchorsOf("## 「検査」(下限): a.b/c\n")).toEqual(["検査下限-abc"]);
  });

  test("turns each space into a hyphen even when a removed symbol sits between spaces", () => {
    expect(anchorsOf("## A / B\n")).toEqual(["a--b"]);
  });

  test("keeps hyphens and underscores", () => {
    expect(anchorsOf("## needs_human - ok\n")).toEqual(["needs_human---ok"]);
  });

  test("uses the text of an inline code span in a heading", () => {
    expect(anchorsOf("## `mise run check`を使う\n")).toEqual([
      "mise-run-checkを使う",
    ]);
  });

  test("uses only the link text of an inline link in a heading", () => {
    expect(anchorsOf("## [運用](operations.md)の決まり\n")).toEqual([
      "運用の決まり",
    ]);
  });

  test("uses only the link text of a reference link in a heading", () => {
    expect(
      anchorsOf("## [運用][ops]の決まり\n\n[ops]: operations.md\n"),
    ).toEqual(["運用の決まり"]);
  });

  test("leaves the alt text of an image out of the heading text", () => {
    expect(anchorsOf("## ![図](a.png) 手順\n")).toEqual(["-手順"]);
  });

  test("decodes a character reference in a heading", () => {
    expect(anchorsOf("## A &amp; B\n")).toEqual(["a--b"]);
  });

  test("keeps the text of an HTML comment inside a code span in a heading", () => {
    expect(anchorsOf("## `<!-- x -->`\n")).toEqual(["---x---"]);
  });

  test("drops inline HTML tags in a heading and keeps the text between them", () => {
    expect(anchorsOf("## 手順<span>です</span>\n")).toEqual(["手順です"]);
  });

  test("keeps the hyphen for the space before an inline HTML element in a heading", () => {
    expect(anchorsOf("## 手順 <!-- 注 -->\n")).toEqual(["手順-"]);
  });

  test("drops the closing hashes of a heading", () => {
    expect(anchorsOf("## 手順 ##\n")).toEqual(["手順"]);
  });

  test("drops emphasis markers with an underscore in a heading", () => {
    expect(anchorsOf("## _強調_ needs_human\n")).toEqual(["強調-needs_human"]);
  });

  test("keeps underscores that cannot close emphasis because a letter follows", () => {
    expect(anchorsOf("## _強調_と needs_human\n")).toEqual([
      "_強調_と-needs_human",
    ]);
  });

  test("keeps an escaped character in a heading", () => {
    expect(anchorsOf("## a\\_b\n")).toEqual(["a_b"]);
  });

  test("numbers duplicated headings with -1, -2", () => {
    expect(
      anchorsOf("## 残るリスク\n\n## 残るリスク\n\n## 残るリスク\n"),
    ).toEqual(["残るリスク", "残るリスク-1", "残るリスク-2"]);
  });

  test("numbers a heading that collides with an earlier numbered slug", () => {
    expect(anchorsOf("# foo\n\n# foo\n\n# foo-1\n")).toEqual([
      "foo",
      "foo-1",
      "foo-1-1",
    ]);
  });

  test("collects a heading inside a block quote", () => {
    expect(anchorsOf("> # 引用の見出し\n")).toEqual(["引用の見出し"]);
  });

  test("collects a heading inside a list item", () => {
    expect(anchorsOf("- # 項目の見出し\n")).toEqual(["項目の見出し"]);
  });

  test("collects setext headings of both levels", () => {
    expect(anchorsOf("見出し\n===\n\n別の見出し\n---\n")).toEqual([
      "見出し",
      "別の見出し",
    ]);
  });

  test("ignores headings inside fenced code blocks", () => {
    expect(anchorsOf("```md\n# 中\n```\n\n~~~\n# 中2\n~~~\n")).toEqual([]);
  });

  test("ignores a hash line inside a longer fence that has a shorter fence in it", () => {
    expect(anchorsOf("````md\n```\n# 中\n```\n````\n\n# 外\n")).toEqual(["外"]);
  });

  test("ignores a heading inside a fence in a block quote", () => {
    expect(anchorsOf("> ```\n> # 中\n> ```\n")).toEqual([]);
  });

  test("ignores a heading inside an indented code block", () => {
    expect(anchorsOf("段落\n\n    # 中\n")).toEqual([]);
  });

  test("ignores lines that only look like headings", () => {
    expect(anchorsOf("#見出しではない\n\n####### 七つ\n")).toEqual([]);
  });

  test("ignores a hash line inside frontmatter", () => {
    expect(anchorsOf("---\ntitle: x\n# コメント\n---\n\n# 本文\n")).toEqual([
      "本文",
    ]);
  });

  test("ignores headings inside an HTML comment", () => {
    expect(anchorsOf("<!--\n# 中\n-->\n")).toEqual([]);
  });

  test("reads a heading after a line that opens a comment in the middle of a paragraph", () => {
    expect(anchorsOf("本文 <!-- `\n# 中\n--> `\n# 外\n")).toEqual(["中", "外"]);
  });

  test("reads a heading after a code span that holds a comment opener", () => {
    expect(anchorsOf("前 `<!--` 後\n\n# 見出し\n\n本文 `-->`\n")).toEqual([
      "見出し",
    ]);
  });
});

describe("indexDoc anchors from HTML attributes", () => {
  test("collects the id and the name of an anchor tag", () => {
    expect(
      anchorsOf('<a id="r-host-03"></a>\n\n本文 <a name="legacy">旧</a>\n'),
    ).toEqual(["r-host-03", "legacy"]);
  });

  test("collects the id of an element that is not an anchor tag", () => {
    expect(anchorsOf('<div id="box">\n\n本文\n\n</div>\n')).toEqual(["box"]);
  });

  test("collects single-quoted and unquoted values", () => {
    expect(anchorsOf("<a id='q'></a><a id=u></a>\n")).toEqual(["q", "u"]);
  });

  test("collects an anchor tag inside a table cell", () => {
    expect(
      anchorsOf('| ID | 対象 |\n| --- | --- |\n| <a id="r-1"></a>R-1 | x |\n'),
    ).toEqual(["r-1"]);
  });

  test("collects the id of an element inside a heading next to the heading anchor", () => {
    expect(anchorsOf('## 手順<a id="steps"></a>\n')).toEqual(["手順", "steps"]);
  });

  test("does not pick an attribute whose name only ends with id", () => {
    expect(anchorsOf('<span data-id="x" class="y"></span>\n')).toEqual([]);
  });

  test("does not pick id= written inside another attribute value", () => {
    expect(anchorsOf('<a title="id=x"></a>\n')).toEqual([]);
  });

  test("ignores an anchor tag inside inline code", () => {
    expect(anchorsOf('`<a id="x"></a>`と書く\n')).toEqual([]);
  });

  test("ignores an anchor tag inside a fenced code block", () => {
    expect(anchorsOf('```html\n<a id="x"></a>\n```\n')).toEqual([]);
  });

  test("ignores an anchor tag inside an HTML comment", () => {
    expect(anchorsOf('<!-- <a id="x"></a> -->\n')).toEqual([]);
  });

  test("does not count an anchor tag in the duplicate numbering of headings", () => {
    expect(anchorsOf('<a id="a"></a>\n\n# a\n')).toEqual(["a"]);
  });
});

describe("indexDoc links", () => {
  test("returns the target and the line of an inline link", () => {
    const { links } = indexDoc("本文\n\n[運用](operations.md#通知)を読む。\n");

    expect(links).toEqual([{ line: 3, target: "operations.md#通知" }]);
  });

  test("returns every link on a line", () => {
    expect(targetsOf("[a](a.md)と[b](b.md)\n")).toEqual(["a.md", "b.md"]);
  });

  test("does not return the target of an image", () => {
    expect(targetsOf("![図](fig.png)\n")).toEqual([]);
  });

  test("drops the title of a link", () => {
    expect(targetsOf('[a](a.md "題")\n')).toEqual(["a.md"]);
  });

  test("reads a target in angle brackets that contains a space", () => {
    expect(targetsOf("[a](<my file.md>)\n")).toEqual(["my file.md"]);
  });

  test("reads a target that contains balanced parentheses", () => {
    expect(targetsOf("[a](docs/a(1).md)\n")).toEqual(["docs/a(1).md"]);
  });

  test("finds a link whose text contains brackets", () => {
    expect(targetsOf("[a [b] c](a.md)\n")).toEqual(["a.md"]);
  });

  test("finds a link whose text contains inline code", () => {
    expect(targetsOf("[`a`](a.md)\n")).toEqual(["a.md"]);
  });

  test("reads the target of a reference definition", () => {
    expect(indexDoc("[ref]: ./a.md#x\n").links).toEqual([
      { line: 1, target: "./a.md#x" },
    ]);
  });

  test("reads the target of a reference link once, from its definition", () => {
    expect(targetsOf("[a][r]\n\n[r]: a.md\n")).toEqual(["a.md"]);
  });

  test("returns the target of an autolink", () => {
    expect(targetsOf("<https://example.com/a>\n")).toEqual([
      "https://example.com/a",
    ]);
  });

  test("ignores a reference definition that only an image uses", () => {
    expect(indexDoc("![図][fig]\n\n[fig]: none.png\n").links).toEqual([]);
  });

  test("ignores a reference definition that only a collapsed or shortcut image uses", () => {
    expect(
      indexDoc("![fig][]と![fig2]\n\n[fig]: a.png\n[fig2]: b.png\n").links,
    ).toEqual([]);
  });

  test("matches an image reference to its definition regardless of case", () => {
    expect(indexDoc("![図][FIG]\n\n[fig]: none.png\n").links).toEqual([]);
  });

  test("reads a reference definition that a link and an image both use", () => {
    expect(indexDoc("[a][r]と![図][r]\n\n[r]: a.md\n").links).toEqual([
      { line: 3, target: "a.md" },
    ]);
  });

  test("reads a reference definition that nothing uses", () => {
    expect(indexDoc("[r]: a.md\n").links).toEqual([
      { line: 1, target: "a.md" },
    ]);
  });

  test("ignores a footnote definition", () => {
    expect(targetsOf("本文[^1]\n\n[^1]: 注\n")).toEqual([]);
  });

  test("ignores a link whose opening bracket is escaped", () => {
    expect(targetsOf("\\[a](none.md)\n")).toEqual([]);
  });

  test("ignores links inside inline code", () => {
    expect(targetsOf("`[a](a.md)`と``[b](b.md)``\n")).toEqual([]);
  });

  test("ignores a link inside a code span that spans lines", () => {
    expect(targetsOf("`a\n[x](none.md)`\n")).toEqual([]);
  });

  test("ignores links inside fenced code blocks", () => {
    expect(targetsOf("```md\n[a](a.md)\n```\n\n~~~\n[b](b.md)\n~~~\n")).toEqual(
      [],
    );
  });

  test("ignores a link inside a fence in a block quote", () => {
    expect(targetsOf("> ```\n> [a](none.md)\n> ```\n")).toEqual([]);
  });

  test("ignores a link inside an indented code block", () => {
    expect(targetsOf("段落\n\n    [a](none.md)\n")).toEqual([]);
  });

  test("ignores links inside an HTML comment", () => {
    expect(targetsOf("<!-- [a](a.md) -->\n\n<!--\n[b](b.md)\n-->\n")).toEqual(
      [],
    );
  });

  test("reads a link after a comment that holds a backtick on the same line", () => {
    expect(indexDoc("前 <!-- ` --> [a](none.md) ` 後\n").links).toEqual([
      { line: 1, target: "none.md" },
    ]);
  });

  test("reads a link after a closed fence and a closed comment", () => {
    expect(indexDoc("```\nx\n```\n\n本文<!-- c -->[a](a.md)\n").links).toEqual([
      { line: 5, target: "a.md" },
    ]);
  });
});

/** `files`のパスと本文から、`LinkResolver`を作る。 */
function fakeResolver(files: Readonly<Record<string, string>>): LinkResolver {
  return createLinkResolver(Object.keys(files), (path) => files[path]);
}

const REPO: Readonly<Record<string, string>> = {
  "docs/a.md": "# A\n\n## 手順\n",
  "docs/internals/b.md": "# B\n\n## 再実行する回\n",
  "README.md": "# README\n",
  "f/factory/x.ts": "export {};\n",
};

/** `REPO`に`path`の文書を足し、そのリンクを検査する。 */
function lintIn(path: string, markdown: string): string[] {
  return lintDocLinks(path, fakeResolver({ ...REPO, [path]: markdown }));
}

describe("lintDocLinks", () => {
  test("accepts a link to an existing file", () => {
    expect(lintIn("README.md", "[a](docs/a.md)\n")).toEqual([]);
  });

  test("accepts a link to an existing anchor in another file", () => {
    expect(lintIn("README.md", "[a](docs/a.md#手順)\n")).toEqual([]);
  });

  test("accepts an anchor in the same file", () => {
    expect(lintIn("docs/a.md", "[手順](#手順)\n\n## 手順\n")).toEqual([]);
  });

  test("accepts the built-in top anchor of the same file", () => {
    expect(lintIn("docs/a.md", "[上へ](#top)\n")).toEqual([]);
  });

  test("resolves a path relative to the directory of the document", () => {
    expect(lintIn("docs/internals/b.md", "[a](../a.md#手順)\n")).toEqual([]);
  });

  test("resolves a path that starts with a slash from the repository root", () => {
    expect(lintIn("docs/internals/b.md", "[a](/docs/a.md#手順)\n")).toEqual([]);
  });

  test("accepts a link to a directory that holds tracked files", () => {
    expect(lintIn("README.md", "[f](f/factory)と[g](f/factory/)\n")).toEqual(
      [],
    );
  });

  test("accepts a link with a leading dot segment", () => {
    expect(lintIn("README.md", "[a](./docs/a.md)\n")).toEqual([]);
  });

  test("reports a link to a file that does not exist", () => {
    expect(lintIn("README.md", "\n[a](docs/none.md)\n")).toEqual([
      "README.md:2: [link] file not found: docs/none.md",
    ]);
  });

  test("reports a link whose path differs from a tracked file only in case", () => {
    expect(lintIn("README.md", "[a](docs/A.md)\n")).toEqual([
      "README.md:1: [link] file not found: docs/A.md",
    ]);
  });

  test("reports a path that is resolved from the wrong directory", () => {
    expect(
      lintDocLinks(
        "docs/internals/b.md",
        fakeResolver({
          "docs/internals/b.md": "[s](setup.md#x)\n",
          "docs/setup.md": "# x\n",
        }),
      ),
    ).toEqual(["docs/internals/b.md:1: [link] file not found: setup.md#x"]);
  });

  test("reports an anchor that is missing in another file", () => {
    expect(lintIn("README.md", "[a](docs/a.md#存在しない)\n")).toEqual([
      "README.md:1: [link] anchor not found: docs/a.md#存在しない",
    ]);
  });

  test("reports an anchor that is missing in the same file", () => {
    expect(lintIn("docs/a.md", "[x](#無い)\n")).toEqual([
      "docs/a.md:1: [link] anchor not found: #無い",
    ]);
  });

  test("reports top of another file as a missing anchor", () => {
    expect(lintIn("README.md", "[a](docs/a.md#top)\n")).toEqual([
      "README.md:1: [link] anchor not found: docs/a.md#top",
    ]);
  });

  test("distinguishes the case of an anchor", () => {
    expect(
      lintDocLinks(
        "README.md",
        fakeResolver({
          "README.md": "[a](docs/internals/b.md#Check)\n",
          "docs/internals/b.md": "# Check\n",
        }),
      ),
    ).toEqual([
      "README.md:1: [link] anchor not found: docs/internals/b.md#Check",
    ]);
  });

  test("decodes a percent-encoded anchor", () => {
    expect(lintIn("README.md", "[a](docs/a.md#%E6%89%8B%E9%A0%86)\n")).toEqual(
      [],
    );
  });

  test("keeps a malformed percent sequence as it is", () => {
    expect(lintIn("README.md", "[a](docs/a.md#%E3)\n")).toEqual([
      "README.md:1: [link] anchor not found: docs/a.md#%E3",
    ]);
  });

  test("does not check an anchor of a file that is not Markdown", () => {
    expect(lintIn("README.md", "[x](f/factory/x.ts#L10)\n")).toEqual([]);
  });

  test("ignores external URLs", () => {
    const markdown =
      "[a](https://example.com/a#x)と[b](http://example.com)と[c](mailto:a@example.com)と<https://example.com>\n";

    expect(lintIn("README.md", markdown)).toEqual([]);
  });

  test("ignores a link to the top of the same file", () => {
    expect(lintIn("README.md", "[top](#)\n")).toEqual([]);
  });

  test("reports a link that leaves the repository", () => {
    expect(lintIn("README.md", "[a](../outside.md)\n")).toEqual([
      "README.md:1: [link] file not found: ../outside.md",
    ]);
  });

  test("ignores a broken link inside inline code and fenced code", () => {
    expect(
      lintIn("README.md", "`[a](none.md)`\n\n```md\n[b](none.md)\n```\n"),
    ).toEqual([]);
  });

  test("reports a broken link in a reference definition at the line of the definition", () => {
    expect(lintIn("README.md", "[a][r]\n\n[r]: none.md\n")).toEqual([
      "README.md:3: [link] file not found: none.md",
    ]);
  });

  test("reports every broken link in line order", () => {
    expect(
      lintIn("README.md", "[a](none-a.md)\n\n[b](docs/a.md#無い)\n"),
    ).toEqual([
      "README.md:1: [link] file not found: none-a.md",
      "README.md:3: [link] anchor not found: docs/a.md#無い",
    ]);
  });

  test("resolves an anchor to an explicit anchor tag", () => {
    expect(
      lintDocLinks(
        "README.md",
        fakeResolver({
          "README.md": "[R-HOST-03](docs/risks.md#r-host-03)\n",
          "docs/risks.md": '| <a id="r-host-03"></a>R-HOST-03 | x |\n',
        }),
      ),
    ).toEqual([]);
  });

  test("returns nothing for a document that the resolver cannot read", () => {
    expect(lintDocLinks("missing.md", fakeResolver({}))).toEqual([]);
  });

  test("reports a link that ends with a slash to a file", () => {
    expect(lintIn("README.md", "[a](docs/a.md/)\n")).toEqual([
      "README.md:1: [link] file not found: docs/a.md/",
    ]);
  });

  test("reports a link that ends with a slash to a path that does not exist", () => {
    expect(lintIn("README.md", "[a](docs/none/)\n")).toEqual([
      "README.md:1: [link] file not found: docs/none/",
    ]);
  });

  test("accepts a link to the root directory", () => {
    expect(lintIn("docs/a.md", "[root](/)と[up](../)\n")).toEqual([]);
  });

  test("does not check the anchor of a link to a directory", () => {
    expect(lintIn("README.md", "[f](f/factory/#無い)\n")).toEqual([]);
  });

  test("does not check the anchor of a link with a query", () => {
    expect(lintIn("README.md", "[a](docs/a.md?plain=1#L10)\n")).toEqual([]);
  });

  test("does not check a missing heading anchor of a link with a query", () => {
    expect(lintIn("README.md", "[a](docs/a.md?plain=1#無い)\n")).toEqual([]);
  });

  test("still reports a file that does not exist when the link has a query", () => {
    expect(lintIn("README.md", "[a](docs/none.md?plain=1#L10)\n")).toEqual([
      "README.md:1: [link] file not found: docs/none.md?plain=1#L10",
    ]);
  });

  test.each([
    ["a single line", "#L10"],
    ["a range of lines", "#L10-L20"],
    ["a range with columns", "#L10C5-L20C8"],
  ])("does not check %s as an anchor", (_, anchor) => {
    expect(lintIn("README.md", `[a](docs/a.md${anchor})\n`)).toEqual([]);
  });

  test("does not check a line anchor of the same file", () => {
    expect(lintIn("docs/a.md", "[l](#L10)\n")).toEqual([]);
  });

  test("checks an anchor that only starts like a line anchor", () => {
    expect(lintIn("README.md", "[a](docs/a.md#L10x)\n")).toEqual([
      "README.md:1: [link] anchor not found: docs/a.md#L10x",
    ]);
  });

  test.each([
    ["a footnote", "#user-content-fn-1"],
    ["a footnote reference", "#user-content-fnref-1"],
  ])("does not check %s as an anchor", (_, anchor) => {
    expect(lintIn("README.md", `[a](docs/a.md${anchor})\n`)).toEqual([]);
  });

  test("still reports a file that does not exist when the link points at a footnote", () => {
    expect(
      lintIn("README.md", "[a](docs/none.md#user-content-fn-1)\n"),
    ).toEqual([
      "README.md:1: [link] file not found: docs/none.md#user-content-fn-1",
    ]);
  });

  test("does not skip an anchor that only contains user-content-", () => {
    expect(lintIn("README.md", "[a](docs/a.md#user-content-x)\n")).toEqual([
      "README.md:1: [link] anchor not found: docs/a.md#user-content-x",
    ]);
  });
});

describe("createLinkResolver", () => {
  test("accepts a tracked file, a directory above one, and the root", () => {
    const resolver = fakeResolver(REPO);

    expect([
      resolver.exists("docs/a.md"),
      resolver.exists("docs/internals"),
      resolver.exists("."),
    ]).toEqual([true, true, true]);
  });

  test("rejects a file that is not in the list, even when only its case matches", () => {
    const resolver = fakeResolver(REPO);

    expect([
      resolver.exists("docs/A.md"),
      resolver.exists("docs/none.md"),
    ]).toEqual([false, false]);
  });

  test("tells a directory from a file", () => {
    const resolver = fakeResolver(REPO);

    expect([
      resolver.isDirectory("docs/internals"),
      resolver.isDirectory("."),
      resolver.isDirectory("docs/a.md"),
      resolver.isDirectory("docs/none"),
    ]).toEqual([true, true, false, false]);
  });

  test("returns the anchors of a tracked Markdown file", () => {
    const resolver = fakeResolver(REPO);

    expect([...(resolver.indexOf("docs/a.md")?.anchors ?? [])]).toEqual([
      "a",
      "手順",
    ]);
  });

  test("returns nothing for a file that is not Markdown, a directory, or a missing path", () => {
    const resolver = fakeResolver(REPO);

    expect([
      resolver.indexOf("f/factory/x.ts"),
      resolver.indexOf("docs"),
      resolver.indexOf("docs/none.md"),
    ]).toEqual([undefined, undefined, undefined]);
  });

  test("returns nothing for a tracked Markdown file that cannot be read", () => {
    const resolver = createLinkResolver(["a.md"], () => undefined);

    expect(resolver.indexOf("a.md")).toBeUndefined();
  });

  test("reads and parses each document once", () => {
    const reads: string[] = [];
    const resolver = createLinkResolver(["a.md"], (path) => {
      reads.push(path);
      return "# A\n";
    });

    resolver.indexOf("a.md");
    resolver.indexOf("a.md");

    expect(reads).toEqual(["a.md"]);
  });

  test("uses the given tree reader, so another check can share the parsed trees", () => {
    const resolver = createLinkResolver(
      ["a.md"],
      () => "# A\n",
      () => parseMarkdown("# B\n"),
    );

    expect(resolver.indexOf("a.md")?.anchors.has("b")).toBe(true);
  });
});
