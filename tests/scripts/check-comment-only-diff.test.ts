import { describe, expect, test } from "bun:test";
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
