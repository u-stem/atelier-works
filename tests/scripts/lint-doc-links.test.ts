import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectAnchors,
  createFsResolver,
  extractLinks,
  githubSlug,
  type LinkResolver,
  lintDocLinkFiles,
  lintDocLinks,
} from "../../scripts/lint-doc-links.ts";

describe("githubSlug", () => {
  test("lowercases ASCII letters", () => {
    expect(githubSlug("Check CI")).toBe("check-ci");
  });

  test("keeps Japanese characters as they are", () => {
    expect(githubSlug("収集の運用")).toBe("収集の運用");
  });

  test("removes punctuation, symbols, and Japanese brackets", () => {
    expect(githubSlug("「検査」(下限): a.b/c")).toBe("検査下限-abc");
  });

  test("keeps hyphens and underscores", () => {
    expect(githubSlug("needs_human - ok")).toBe("needs_human---ok");
  });

  test("turns each space into a hyphen even when a removed symbol sits between spaces", () => {
    expect(githubSlug("A / B")).toBe("a--b");
  });

  test("keeps the long vowel mark and digits", () => {
    expect(githubSlug("サーバー2台")).toBe("サーバー2台");
  });
});

describe("collectAnchors", () => {
  test("collects headings of every level", () => {
    const anchors = collectAnchors("# 一\n\n## 二\n\n###### 六\n");

    expect([...anchors]).toEqual(["一", "二", "六"]);
  });

  test("uses the text of an inline code span in a heading", () => {
    const anchors = collectAnchors("## `mise run check`を使う\n");

    expect(anchors.has("mise-run-checkを使う")).toBe(true);
  });

  test("uses only the link text of a link in a heading", () => {
    const anchors = collectAnchors("## [運用](operations.md)の決まり\n");

    expect(anchors.has("運用の決まり")).toBe(true);
  });

  test("drops inline HTML tags in a heading", () => {
    const anchors = collectAnchors('## 手順 <a id="steps"></a>\n');

    expect(anchors.has("手順")).toBe(true);
  });

  test("drops the closing hashes of a heading", () => {
    const anchors = collectAnchors("## 手順 ##\n");

    expect(anchors.has("手順")).toBe(true);
  });

  test("drops emphasis markers with an underscore in a heading", () => {
    const anchors = collectAnchors("## _強調_と needs_human\n");

    expect(anchors.has("強調と-needs_human")).toBe(true);
  });

  test("keeps an escaped character in a heading", () => {
    const anchors = collectAnchors("## a\\_b\n");

    expect(anchors.has("a_b")).toBe(true);
  });

  test("numbers duplicated headings with -1, -2", () => {
    const anchors = collectAnchors(
      "## 残るリスク\n\n## 残るリスク\n\n## 残るリスク\n",
    );

    expect([...anchors]).toEqual([
      "残るリスク",
      "残るリスク-1",
      "残るリスク-2",
    ]);
  });

  test("numbers a heading that collides with an earlier numbered slug", () => {
    const anchors = collectAnchors("# foo\n\n# foo\n\n# foo-1\n");

    expect([...anchors]).toEqual(["foo", "foo-1", "foo-1-1"]);
  });

  test("ignores headings inside fenced code blocks", () => {
    const anchors = collectAnchors("```md\n# 中\n```\n\n~~~\n# 中2\n~~~\n");

    expect(anchors.size).toBe(0);
  });

  test("ignores a hash line inside a longer fence that has a shorter fence in it", () => {
    const anchors = collectAnchors("````md\n```\n# 中\n```\n````\n\n# 外\n");

    expect([...anchors]).toEqual(["外"]);
  });

  test("ignores lines that only look like headings", () => {
    const anchors = collectAnchors("#見出しではない\n\n####### 七つ\n");

    expect(anchors.size).toBe(0);
  });

  test("ignores headings inside an HTML comment", () => {
    const anchors = collectAnchors("<!--\n# 中\n-->\n");

    expect(anchors.size).toBe(0);
  });

  test("collects the id and the name of an anchor tag", () => {
    const anchors = collectAnchors(
      '<a id="r-host-03"></a>\n\n本文 <a name="legacy">旧</a>\n',
    );

    expect([...anchors]).toEqual(["r-host-03", "legacy"]);
  });

  test("collects an anchor tag inside a table cell", () => {
    const anchors = collectAnchors(
      '| ID | 対象 |\n| --- | --- |\n| <a id="r-1"></a>R-1 | x |\n',
    );

    expect(anchors.has("r-1")).toBe(true);
  });

  test("ignores an anchor tag inside inline code", () => {
    const anchors = collectAnchors('`<a id="x"></a>`と書く\n');

    expect(anchors.size).toBe(0);
  });

  test("does not count an anchor tag in the duplicate numbering of headings", () => {
    const anchors = collectAnchors('<a id="a"></a>\n\n# a\n');

    expect([...anchors]).toEqual(["a"]);
  });
});

describe("extractLinks", () => {
  test("returns the target and the line of an inline link", () => {
    const links = extractLinks("本文\n\n[運用](operations.md#通知)を読む。\n");

    expect(links).toEqual([{ line: 3, target: "operations.md#通知" }]);
  });

  test("returns every link on a line", () => {
    const links = extractLinks("[a](a.md)と[b](b.md)\n");

    expect(links.map((link) => link.target)).toEqual(["a.md", "b.md"]);
  });

  test("returns the target of an image", () => {
    const links = extractLinks("![図](fig.png)\n");

    expect(links.map((link) => link.target)).toEqual(["fig.png"]);
  });

  test("drops the title of a link", () => {
    const links = extractLinks('[a](a.md "題")\n');

    expect(links.map((link) => link.target)).toEqual(["a.md"]);
  });

  test("reads a target in angle brackets that contains a space", () => {
    const links = extractLinks("[a](<my file.md>)\n");

    expect(links.map((link) => link.target)).toEqual(["my file.md"]);
  });

  test("finds a link whose text contains brackets", () => {
    const links = extractLinks("[a [b] c](a.md)\n");

    expect(links.map((link) => link.target)).toEqual(["a.md"]);
  });

  test("finds a link whose text contains inline code", () => {
    const links = extractLinks("[`a`](a.md)\n");

    expect(links.map((link) => link.target)).toEqual(["a.md"]);
  });

  test("reads the target of a reference definition", () => {
    const links = extractLinks("[ref]: ./a.md#x\n");

    expect(links).toEqual([{ line: 1, target: "./a.md#x" }]);
  });

  test("ignores a footnote definition", () => {
    const links = extractLinks("[^1]: 注\n");

    expect(links).toEqual([]);
  });

  test("ignores links inside inline code", () => {
    const links = extractLinks("`[a](a.md)`と``[b](b.md)``\n");

    expect(links).toEqual([]);
  });

  test("ignores links inside fenced code blocks", () => {
    const links = extractLinks(
      "```md\n[a](a.md)\n```\n\n~~~\n[b](b.md)\n~~~\n",
    );

    expect(links).toEqual([]);
  });

  test("ignores links inside an HTML comment", () => {
    const links = extractLinks("<!-- [a](a.md) -->\n\n<!--\n[b](b.md)\n-->\n");

    expect(links).toEqual([]);
  });

  test("reads a link after a closed fence and a closed comment", () => {
    const links = extractLinks("```\nx\n```\n<!-- c -->[a](a.md)\n");

    expect(links).toEqual([{ line: 4, target: "a.md" }]);
  });
});

/** `files`にあるMarkdownの本文からアンカーを集めて答える`LinkResolver`。 */
function fakeResolver(
  files: Readonly<Record<string, string>>,
  directories: readonly string[] = [],
): LinkResolver {
  return {
    exists: (path) => path in files || directories.includes(path),
    anchorsOf: (path) => {
      const body = files[path];
      return body !== undefined && path.endsWith(".md")
        ? collectAnchors(body)
        : undefined;
    },
  };
}

const RESOLVER = fakeResolver(
  {
    "docs/a.md": "# A\n\n## 手順\n",
    "docs/internals/b.md": "# B\n\n## 再実行する回\n",
    "README.md": "# README\n",
    "f/x.ts": "export {};\n",
  },
  ["f/factory"],
);

describe("lintDocLinks", () => {
  test("accepts a link to an existing file", () => {
    expect(lintDocLinks("README.md", "[a](docs/a.md)\n", RESOLVER)).toEqual([]);
  });

  test("accepts a link to an existing anchor in another file", () => {
    expect(
      lintDocLinks("README.md", "[a](docs/a.md#手順)\n", RESOLVER),
    ).toEqual([]);
  });

  test("accepts an anchor in the same file", () => {
    expect(
      lintDocLinks("docs/a.md", "[手順](#手順)\n\n## 手順\n", RESOLVER),
    ).toEqual([]);
  });

  test("resolves a path relative to the directory of the document", () => {
    expect(
      lintDocLinks("docs/internals/b.md", "[a](../a.md#手順)\n", RESOLVER),
    ).toEqual([]);
  });

  test("resolves a path that starts with a slash from the repository root", () => {
    expect(
      lintDocLinks("docs/internals/b.md", "[a](/docs/a.md#手順)\n", RESOLVER),
    ).toEqual([]);
  });

  test("accepts a link to a directory", () => {
    expect(
      lintDocLinks("README.md", "[f](f/factory)と[g](f/factory/)\n", RESOLVER),
    ).toEqual([]);
  });

  test("accepts a link with a leading dot segment", () => {
    expect(lintDocLinks("README.md", "[a](./docs/a.md)\n", RESOLVER)).toEqual(
      [],
    );
  });

  test("reports a link to a file that does not exist", () => {
    expect(
      lintDocLinks("README.md", "\n[a](docs/none.md)\n", RESOLVER),
    ).toEqual(["README.md:2: [link] file not found: docs/none.md"]);
  });

  test("reports a path that is resolved from the wrong directory", () => {
    expect(
      lintDocLinks(
        "docs/internals/b.md",
        "[s](setup.md#x)\n",
        fakeResolver({
          "docs/setup.md": "# x\n",
        }),
      ),
    ).toEqual(["docs/internals/b.md:1: [link] file not found: setup.md#x"]);
  });

  test("reports an anchor that is missing in another file", () => {
    expect(
      lintDocLinks("README.md", "[a](docs/a.md#存在しない)\n", RESOLVER),
    ).toEqual(["README.md:1: [link] anchor not found: docs/a.md#存在しない"]);
  });

  test("reports an anchor that is missing in the same file", () => {
    expect(lintDocLinks("docs/a.md", "[x](#無い)\n", RESOLVER)).toEqual([
      "docs/a.md:1: [link] anchor not found: #無い",
    ]);
  });

  test("distinguishes the case of an anchor", () => {
    expect(
      lintDocLinks(
        "README.md",
        "[a](docs/internals/b.md#Check)\n",
        fakeResolver({
          "docs/internals/b.md": "# Check\n",
        }),
      ),
    ).toEqual([
      "README.md:1: [link] anchor not found: docs/internals/b.md#Check",
    ]);
  });

  test("decodes a percent-encoded anchor", () => {
    expect(
      lintDocLinks(
        "README.md",
        "[a](docs/a.md#%E6%89%8B%E9%A0%86)\n",
        RESOLVER,
      ),
    ).toEqual([]);
  });

  test("keeps a malformed percent sequence as it is", () => {
    expect(lintDocLinks("README.md", "[a](docs/a.md#%E3)\n", RESOLVER)).toEqual(
      ["README.md:1: [link] anchor not found: docs/a.md#%E3"],
    );
  });

  test("does not check an anchor of a file that is not Markdown", () => {
    expect(lintDocLinks("README.md", "[x](f/x.ts#L10)\n", RESOLVER)).toEqual(
      [],
    );
  });

  test("ignores external URLs", () => {
    const markdown =
      "[a](https://example.com/a#x)と[b](http://example.com)と[c](mailto:a@example.com)\n";

    expect(lintDocLinks("README.md", markdown, RESOLVER)).toEqual([]);
  });

  test("ignores a link to the top of the same file", () => {
    expect(lintDocLinks("README.md", "[top](#)\n", RESOLVER)).toEqual([]);
  });

  test("reports a link that leaves the repository", () => {
    expect(lintDocLinks("README.md", "[a](../outside.md)\n", RESOLVER)).toEqual(
      ["README.md:1: [link] file not found: ../outside.md"],
    );
  });

  test("ignores a broken link inside inline code and fenced code", () => {
    const markdown = "`[a](none.md)`\n\n```md\n[b](none.md)\n```\n";

    expect(lintDocLinks("README.md", markdown, RESOLVER)).toEqual([]);
  });

  test("reports every broken link in line order", () => {
    const markdown = "[a](none-a.md)\n\n[b](docs/a.md#無い)\n";

    expect(lintDocLinks("README.md", markdown, RESOLVER)).toEqual([
      "README.md:1: [link] file not found: none-a.md",
      "README.md:3: [link] anchor not found: docs/a.md#無い",
    ]);
  });

  test("resolves an anchor to an explicit anchor tag", () => {
    const resolver = fakeResolver({
      "docs/risks.md": '| <a id="r-host-03"></a>R-HOST-03 | x |\n',
    });

    expect(
      lintDocLinks(
        "README.md",
        "[R-HOST-03](docs/risks.md#r-host-03)\n",
        resolver,
      ),
    ).toEqual([]);
  });
});

describe("lintDocLinkFiles", () => {
  function withRepo(
    files: Readonly<Record<string, string>>,
    run: (root: string) => void,
  ): void {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "lint-doc-links-"));
    try {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("reports broken links of the given documents from the files on disk", () => {
    withRepo(
      {
        "README.md": "[ok](docs/a.md#見出し)と[ng](docs/a.md#無い)\n",
        "docs/a.md": "# 見出し\n",
      },
      (root) => {
        expect(lintDocLinkFiles(["README.md"], root)).toEqual([
          "README.md:1: [link] anchor not found: docs/a.md#無い",
        ]);
      },
    );
  });

  test("reports nothing for documents whose links all resolve", () => {
    withRepo(
      {
        "README.md": "[ok](docs/a.md#見出し)\n",
        "docs/a.md": "# 見出し\n\n[上](../README.md)\n",
      },
      (root) => {
        expect(lintDocLinkFiles(["README.md", "docs/a.md"], root)).toEqual([]);
      },
    );
  });

  test("treats a link to a Markdown file that is not in the given list as a target to read", () => {
    withRepo(
      {
        "README.md": "[x](docs/other.md#節)\n",
        "docs/other.md": "## 節\n",
      },
      (root) => {
        expect(lintDocLinkFiles(["README.md"], root)).toEqual([]);
      },
    );
  });
});

describe("createFsResolver", () => {
  test("reports a file, a directory, and a missing path", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "lint-doc-links-"));
    try {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "a.md"), "# A\n");
      const resolver = createFsResolver(root);

      expect([
        resolver.exists("a.md"),
        resolver.exists("dir"),
        resolver.exists("none.md"),
      ]).toEqual([true, true, false]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the anchors of a Markdown file and nothing for other files", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "lint-doc-links-"));
    try {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "a.md"), "# 題\n");
      writeFileSync(join(root, "b.ts"), "export {};\n");
      const resolver = createFsResolver(root);

      expect([
        [...(resolver.anchorsOf("a.md") ?? [])],
        resolver.anchorsOf("b.ts"),
        resolver.anchorsOf("dir"),
        resolver.anchorsOf("none.md"),
      ]).toEqual([["題"], undefined, undefined, undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
