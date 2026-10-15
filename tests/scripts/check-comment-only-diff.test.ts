import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFile,
  isCommentOnlyChange,
  parseNameStatus,
  transpiledCode,
} from "../../scripts/check-comment-only-diff.ts";

// テンプレートリテラルの置換`${x}`を、テスト用ソース文字列の中に書くための断片。
const SUBST = "$" + "{x}";

describe("isCommentOnlyChange for TypeScript", () => {
  test("accepts a rewritten line comment", () => {
    const before = "// old note\nconst x = 1;\n";
    const after = "// 新しいメモ\nconst x = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts a rewritten trailing line comment", () => {
    const before = "const x = 1; // old\n";
    const after = "const x = 1; // 新\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts a rewritten block comment", () => {
    const before = "/* old */\nconst x = 1;\n";
    const after = "/* 新 */\nconst x = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts a rewritten JSDoc comment", () => {
    const before =
      "/**\n * old\n * @param a x\n */\nfunction f(a: number) {}\n";
    const after = "/**\n * 新\n */\nfunction f(a: number) {}\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts an added comment", () => {
    const before = "const x = 1;\n";
    const after = "// 追加\nconst x = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts a removed comment", () => {
    const before = "// 削除\nconst x = 1;\n";
    const after = "const x = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("accepts added and removed blank lines", () => {
    const before = "const x = 1;\nconst y = 2;\n";
    const after = "const x = 1;\n\n\nconst y = 2;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("rejects a changed `//` inside a string literal", () => {
    const before = 'const u = "http://a";\n';
    const after = 'const u = "http://b";\n';
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed template literal", () => {
    const before = `const s = \`a ${SUBST} b\`;\n`;
    const after = `const s = \`a ${SUBST} c\`;\n`;
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed `//` inside a template literal", () => {
    const before = `const s = \`a // ${SUBST}\`;\n`;
    const after = `const s = \`a // b ${SUBST}\`;\n`;
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed regular expression literal", () => {
    const before = "const r = /a\\/\\/b/;\n";
    const after = "const r = /a\\/\\/c/;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed `//` inside a regular expression literal", () => {
    const before = "const r = /x(\\d+)\\/\\/y/g;\n";
    const after = "const r = /x(\\d+)\\/\\/z/g;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a renamed identifier", () => {
    const before = "const x = 1;\n";
    const after = "const y = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed operator", () => {
    const before = "const x = a + b;\n";
    const after = "const x = a - b;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("rejects a changed shebang line", () => {
    const before = "#!/usr/bin/env bun\nconst x = 1;\n";
    const after = "#!/usr/bin/env node\nconst x = 1;\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });

  test("applies the same rule to .mjs files", () => {
    const before = "// old\nexport const x = 1;\n";
    const after = "// 新\nexport const x = 1;\n";
    expect(isCommentOnlyChange("a.mjs", before, after)).toBe(true);
  });
});

describe("isCommentOnlyChange for hash-comment files", () => {
  test("accepts a changed `#` comment line in a shell script", () => {
    const before = "#!/usr/bin/env bash\n# old\necho hi\n";
    const after = "#!/usr/bin/env bash\n# 新\necho hi\n";
    expect(isCommentOnlyChange("a.sh", before, after)).toBe(true);
  });

  test("accepts a changed indented `#` comment line in yaml", () => {
    const before = "a:\n  # old\n  b: 1\n";
    const after = "a:\n  # 新\n\n  b: 1\n";
    expect(isCommentOnlyChange("a.yaml", before, after)).toBe(true);
  });

  test("rejects a changed shebang", () => {
    const before = "#!/usr/bin/env bash\necho hi\n";
    const after = "#!/bin/sh\necho hi\n";
    expect(isCommentOnlyChange("a.sh", before, after)).toBe(false);
  });

  test("rejects a changed code line", () => {
    const before = "# note\necho hi\n";
    const after = "# note\necho bye\n";
    expect(isCommentOnlyChange("a.sh", before, after)).toBe(false);
  });

  test("rejects a changed indentation in yaml", () => {
    const before = "a:\n  b: 1\n";
    const after = "a:\nb: 1\n";
    expect(isCommentOnlyChange("a.yml", before, after)).toBe(false);
  });

  test("rejects a changed trailing comment as a code change", () => {
    const before = "x = 1 # old\n";
    const after = "x = 1 # 新\n";
    expect(isCommentOnlyChange("a.toml", before, after)).toBe(false);
  });

  test("accepts a changed comment line in a python file", () => {
    const before = "# old\nx = 1\n";
    const after = "# 新\nx = 1\n";
    expect(isCommentOnlyChange("a.py", before, after)).toBe(true);
  });
});

describe("isCommentOnlyChange for SQL", () => {
  test("accepts a changed `--` comment line", () => {
    const before = "-- old\nSELECT 1;\n";
    const after = "-- 新\nSELECT 1;\n";
    expect(isCommentOnlyChange("a.sql", before, after)).toBe(true);
  });

  test("accepts an indented `--` comment line and blank lines", () => {
    const before = "SELECT\n  -- old\n  1;\n";
    const after = "SELECT\n\n  -- 新\n  1;\n";
    expect(isCommentOnlyChange("a.sql", before, after)).toBe(true);
  });

  test("rejects a changed SQL statement", () => {
    const before = "-- note\nSELECT 1;\n";
    const after = "-- note\nSELECT 2;\n";
    expect(isCommentOnlyChange("a.sql", before, after)).toBe(false);
  });
});

describe("isCommentOnlyChange for TSX", () => {
  test("accepts a changed JSX `{/* */}` comment", () => {
    const before = "export const A = () => <b>{/* old */}hi</b>;\n";
    const after = "export const A = () => <b>{/* 新 */}hi</b>;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(true);
  });

  test("accepts a changed line comment in a file with JSX text", () => {
    const before = "// old\nexport const A = () => <b>#(x</b>;\n";
    const after = "// 新\nexport const A = () => <b>#(x</b>;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(true);
  });

  test("rejects a changed JSX text", () => {
    const before = "export const A = () => <b>hi</b>;\n";
    const after = "export const A = () => <b>bye</b>;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(false);
  });

  test("rejects a changed JSX element name", () => {
    const before = "export const A = () => <b>hi</b>;\n";
    const after = "export const A = () => <i>hi</i>;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(false);
  });

  test("rejects a changed shebang", () => {
    const before = "#!/usr/bin/env bun\nexport const A = <b />;\n";
    const after = "#!/usr/bin/env node\nexport const A = <b />;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(false);
  });

  test("rejects a source that fails to transpile", () => {
    const before = "export const A = <b>hi</b>;\n";
    const after = "export const A = <b>hi;\n";
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(false);
  });

  // `)`の後の`/`は除算とみなされ、`#(`でスキャナーが止まる。
  test("falls back to the transpiler for a ts file the tokenizer cannot scan", () => {
    const before = "// old\nif (x) /#(\\d+)/.test(y);\n";
    const after = "// 新\nif (x) /#(\\d+)/.test(y);\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(true);
  });

  test("rejects a changed code line in a ts file the tokenizer cannot scan", () => {
    const before = "if (x) /#(\\d+)/.test(y);\n";
    const after = "if (x) /#(\\d+)/.test(z);\n";
    expect(isCommentOnlyChange("a.ts", before, after)).toBe(false);
  });
});

describe("transpiledCode", () => {
  const withComments =
    "// MARK-line\n/* MARK-block */\n/** MARK-doc */\nexport const A = () => (\n  <b>\n    {/* MARK-jsx */}\n    hi\n  </b>\n); // MARK-trailing\n";

  test("leaves no comment in the output", () => {
    expect(transpiledCode("a.tsx", withComments)).not.toContain("MARK");
  });

  test("keeps the code in the output", () => {
    expect(transpiledCode("a.tsx", withComments)).toContain("hi");
  });
});

// マクロは印のファイルを書く。印ができたら、変換がマクロを実行したことになる。
describe("a macro import is never executed while the sources are compared", () => {
  const SPACES: Record<string, string> = {
    "a space": " ",
    "a vertical tab": String.fromCharCode(0x0b),
    "a no-break space": String.fromCharCode(0xa0),
    "an ideographic space": String.fromCharCode(0x3000),
    "a newline": "\n",
    "a block comment": "/* c */",
  };
  const KEYWORDS = ["with", "assert"] as const;
  const VARIANTS = Object.entries(SPACES).flatMap(([name, gap]) =>
    KEYWORDS.map(
      (keyword) => [`${keyword} and ${name}`, gap, keyword] as const,
    ),
  );

  function macroProbe(): {
    dir: string;
    marker: string;
    make: (gap: string, keyword: string, note: string) => string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "comment-only-macro-"));
    const marker = join(dir, "marker");
    const macro = join(dir, "m.ts");
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs";\nexport function f() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`,
    );
    return {
      dir,
      marker,
      make: (gap, keyword, note) =>
        `// ${note}\nimport { f } from ${JSON.stringify(macro)} ${keyword}${gap}{ type: "macro" };\nexport const x = f();\n`,
    };
  }

  test.each(VARIANTS)(
    "does not run a macro in transpiledCode after %s",
    (_name, gap, keyword) => {
      const probe = macroProbe();
      try {
        try {
          transpiledCode("a.tsx", probe.make(gap, keyword, "n"));
        } catch {
          // 拒否の例外は想定内。印の有無だけを見る。
        }
        expect(existsSync(probe.marker)).toBe(false);
      } finally {
        rmSync(probe.dir, { recursive: true, force: true });
      }
    },
  );

  test.each(VARIANTS)(
    "does not run a macro in a tsx comparison after %s",
    (_name, gap, keyword) => {
      const probe = macroProbe();
      try {
        isCommentOnlyChange(
          "a.tsx",
          probe.make(gap, keyword, "old"),
          probe.make(gap, keyword, "new"),
        );
        expect(existsSync(probe.marker)).toBe(false);
      } finally {
        rmSync(probe.dir, { recursive: true, force: true });
      }
    },
  );

  test.each(VARIANTS)(
    "does not run a macro in a ts comparison that falls back to the transpiler after %s",
    (_name, gap, keyword) => {
      const probe = macroProbe();
      // `)`の後の`/`は除算とみなされ、スキャナーが止まってトランスパイラに回る。
      const stall = "\nif (x) /#(\\d+)/.test(y);\n";
      try {
        isCommentOnlyChange(
          "a.ts",
          probe.make(gap, keyword, "old") + stall,
          probe.make(gap, keyword, "new") + stall,
        );
        expect(existsSync(probe.marker)).toBe(false);
      } finally {
        rmSync(probe.dir, { recursive: true, force: true });
      }
    },
  );

  // 対照。印のファイルの作り方が誤っていると、上の「印ができない」テストは常に緑になる。
  test("control: the same source run through transformSync does run the macro", () => {
    const probe = macroProbe();
    try {
      new Bun.Transpiler({ loader: "tsx" }).transformSync(
        probe.make(" ", "with", "n"),
      );
      expect(existsSync(probe.marker)).toBe(true);
    } finally {
      rmSync(probe.dir, { recursive: true, force: true });
    }
  });

  test("transpiledCode throws a fixed message for an import attribute", () => {
    const code = 'import j from "./a.json" with { type: "json" };\n';
    expect(() => transpiledCode("a.tsx", code)).toThrow(
      "import attributes are not allowed in compared sources",
    );
  });

  test("treats a source with an import attribute as changed", () => {
    const before = '// old\nimport j from "./a.json" with { type: "json" };\n';
    const after = '// new\nimport j from "./a.json" with { type: "json" };\n';
    expect(isCommentOnlyChange("a.tsx", before, after)).toBe(false);
  });
});

describe("classifyFile", () => {
  test("classifies a TypeScript file as comparable", () => {
    expect(classifyFile("f/a.ts")).toBe("comparable");
  });

  test("classifies a markdown file as skipped", () => {
    expect(classifyFile("README.md")).toBe("skipped");
  });

  test("classifies an unknown extension as skipped", () => {
    expect(classifyFile("image.png")).toBe("skipped");
  });
});

describe("parseNameStatus", () => {
  test("parses modified and added entries", () => {
    const output = "M\0a.ts\0A\0b.sh\0";
    expect(parseNameStatus(output)).toEqual([
      { status: "M", path: "a.ts" },
      { status: "A", path: "b.sh" },
    ]);
  });

  test("takes the new path of a rename entry", () => {
    const output = "R100\0old.ts\0new.ts\0M\0c.ts\0";
    expect(parseNameStatus(output)).toEqual([
      { status: "R100", path: "new.ts" },
      { status: "M", path: "c.ts" },
    ]);
  });

  test("returns an empty list for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});
