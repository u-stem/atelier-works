// 比較の変換が、ソースの中のマクロを実行しないことの確認。
// マクロは印のファイルを書く。印ができたら、変換がマクロを実行したことになる。
// 対照のテストは、同じ入力を素の`transformSync`に通すと印ができることを確かめる。
// 印の作り方や入力の書き方が誤っていると、「印ができない」テストは常に緑になるためである。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCommentOnlyChange,
  transpiledCode,
} from "../../scripts/check-comment-only-diff.ts";

const SPACES: Record<string, string> = {
  "a space": " ",
  "a vertical tab": String.fromCharCode(0x0b),
  "a form feed": String.fromCharCode(0x0c),
  "a no-break space": String.fromCharCode(0xa0),
  "a byte order mark": String.fromCharCode(0xfeff),
  "a line separator": String.fromCharCode(0x2028),
  "a paragraph separator": String.fromCharCode(0x2029),
  "an ideographic space": String.fromCharCode(0x3000),
  "a newline": "\n",
  "a block comment": "/* c */",
  "an html close comment": "\n--> c\n",
  "an html open comment": "\n<!-- c\n",
};
const KEYWORDS = ["with", "assert"] as const;

type Make = (note: string) => string;
type Probe = {
  readonly dir: string;
  readonly marker: string;
  readonly attribute: (gap: string, keyword: string) => Make;
  readonly prefixed: (kind: PrefixKind) => Make;
};
type PrefixKind =
  | "absolute"
  | "relative"
  | "node builtin"
  | "dynamic import"
  | "re-export"
  | "escaped prefix";

function macroProbe(): Probe {
  const dir = mkdtempSync(join(tmpdir(), "comment-only-macro-"));
  const marker = join(dir, "marker");
  const macro = join(dir, "m.ts");
  const quotedMarker = JSON.stringify(marker);
  writeFileSync(
    macro,
    `import { writeFileSync } from "node:fs";\nexport function f() { writeFileSync(${quotedMarker}, "ran"); return 1; }\n`,
  );
  const quotedMacro = JSON.stringify(macro);
  const prefixedMacro = JSON.stringify(`macro:${macro}`);
  // 接頭辞の先頭の文字をUnicodeエスケープで書く。
  const escapedMacro = JSON.stringify(`macro:${macro}`).replace(
    "macro",
    "\\u006dacro",
  );
  const prefixed: Record<PrefixKind, string> = {
    absolute: `import { f } from ${prefixedMacro};\nexport const x = f();\n`,
    relative: `import { f } from "macro:./m.ts";\nexport const x = f();\n`,
    "node builtin": `import { writeFileSync } from "macro:node:fs";\nexport const x = writeFileSync(${quotedMarker}, "ran");\n`,
    "dynamic import": `export const x = await import(${prefixedMacro});\n`,
    "re-export": `export { f } from ${prefixedMacro};\n`,
    "escaped prefix": `import { f } from ${escapedMacro};\nexport const x = f();\n`,
  };
  return {
    dir,
    marker,
    attribute: (gap, keyword) => (note) =>
      `// ${note}\nimport { f } from ${quotedMacro} ${keyword}${gap}{ type: "macro" };\nexport const x = f();\n`,
    prefixed: (kind) => (note) => `// ${note}\n${prefixed[kind]}`,
  };
}

/** 印のファイルを用意し、`body`の後に片付ける。 */
function withProbe(body: (probe: Probe) => void): void {
  const probe = macroProbe();
  try {
    body(probe);
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
}

const ATTRIBUTE_VARIANTS = Object.entries(SPACES).flatMap(([name, gap]) =>
  KEYWORDS.map(
    (keyword) =>
      [
        `${keyword} and ${name}`,
        (probe: Probe) => probe.attribute(gap, keyword),
      ] as const,
  ),
);
const PREFIX_KINDS: readonly PrefixKind[] = [
  "absolute",
  "relative",
  "node builtin",
  "dynamic import",
  "re-export",
  "escaped prefix",
];
const PREFIX_VARIANTS = PREFIX_KINDS.map(
  (kind) =>
    [`a ${kind} macro prefix`, (probe: Probe) => probe.prefixed(kind)] as const,
);
const VARIANTS = [...ATTRIBUTE_VARIANTS, ...PREFIX_VARIANTS];

// `)`の後の`/`は除算とみなされ、スキャナーが止まってトランスパイラに回る。
const STALL = "\nif (x) /#(\\d+)/.test(y);\n";

describe("a macro is never executed by transpiledCode", () => {
  test.each(VARIANTS)("with %s", (_name, build) => {
    withProbe((probe) => {
      try {
        transpiledCode("a.tsx", build(probe)("n"));
      } catch {
        // 拒否の例外は想定内。印の有無だけを見る。
      }
      expect(existsSync(probe.marker)).toBe(false);
    });
  });
});

describe("a macro is never executed by a tsx comparison", () => {
  test.each(VARIANTS)("with %s", (_name, build) => {
    withProbe((probe) => {
      const make = build(probe);
      isCommentOnlyChange("a.tsx", make("old"), make("new"));
      expect(existsSync(probe.marker)).toBe(false);
    });
  });
});

describe("a tsx comparison reports a source with a macro as changed", () => {
  test.each(VARIANTS)("with %s", (_name, build) => {
    withProbe((probe) => {
      const make = build(probe);
      expect(isCommentOnlyChange("a.tsx", make("old"), make("new"))).toBe(
        false,
      );
    });
  });
});

describe("a macro is never executed by a ts comparison that falls back to the transpiler", () => {
  test.each(VARIANTS)("with %s", (_name, build) => {
    withProbe((probe) => {
      const make = build(probe);
      isCommentOnlyChange("a.ts", make("old") + STALL, make("new") + STALL);
      expect(existsSync(probe.marker)).toBe(false);
    });
  });
});

describe("a ts comparison that falls back to the transpiler reports a source with a macro as changed", () => {
  test.each(VARIANTS)("with %s", (_name, build) => {
    withProbe((probe) => {
      const make = build(probe);
      expect(
        isCommentOnlyChange("a.ts", make("old") + STALL, make("new") + STALL),
      ).toBe(false);
    });
  });
});

describe("control: a plain transformSync runs the macro", () => {
  const CONTROLS = [
    ["with and a space", (probe: Probe) => probe.attribute(" ", "with")],
    ["assert and a space", (probe: Probe) => probe.attribute(" ", "assert")],
    [
      "with and a no-break space",
      (probe: Probe) => probe.attribute(String.fromCharCode(0xa0), "with"),
    ],
    ["an absolute macro prefix", (probe: Probe) => probe.prefixed("absolute")],
    [
      "a node builtin macro prefix",
      (probe: Probe) => probe.prefixed("node builtin"),
    ],
    [
      "an escaped macro prefix",
      (probe: Probe) => probe.prefixed("escaped prefix"),
    ],
  ] as const;

  test.each(CONTROLS)("with %s", (_name, build) => {
    withProbe((probe) => {
      try {
        new Bun.Transpiler({ loader: "tsx" }).transformSync(build(probe)("n"));
      } catch {
        // マクロの戻り値をASTにできないときの例外。印の有無だけを見る。
      }
      expect(existsSync(probe.marker)).toBe(true);
    });
  });
});

describe("the fixed messages of the refusal", () => {
  test("an import attribute is refused", () => {
    const code = 'import j from "./a.json" with { type: "json" };\n';
    expect(() => transpiledCode("a.tsx", code)).toThrow(
      "import attributes are not allowed in compared sources",
    );
  });

  test("a macro prefix is refused", () => {
    const code = 'import { f } from "macro:./m.ts";\nexport const x = f();\n';
    expect(() => transpiledCode("a.tsx", code)).toThrow(
      "macro imports are not allowed in compared sources",
    );
  });

  test("a macro prefix written with an escape is refused", () => {
    const code = 'import { f } from "\\u006dacro:./m.ts";';
    expect(() => transpiledCode("a.tsx", code)).toThrow(
      "macro imports are not allowed in compared sources",
    );
  });

  test("a require call with a macro prefix is refused", () => {
    const code = 'const f = require("macro:./m.ts");\n';
    expect(() => transpiledCode("a.js", code)).toThrow(
      "macro imports are not allowed in compared sources",
    );
  });
});

describe("a source without a macro is still transpiled", () => {
  test("an import of a package whose name contains macro", () => {
    const code = 'import { f } from "macro-lib";\nexport const x = f();\n';
    expect(transpiledCode("a.ts", code)).toContain("macro-lib");
  });

  test("a string that only contains the macro prefix", () => {
    const code = 'export const x = "macro:node:fs";\n';
    expect(transpiledCode("a.ts", code)).toContain("macro:node:fs");
  });
});
