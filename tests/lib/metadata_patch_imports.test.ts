import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileScanner,
  type FileRead,
  resolveLocal,
  runtimeScanSelfCheck,
  scanImports,
  traceBareImports,
} from "../../f/factory/lib/metadata_patch_imports.ts";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";
import { readRepoFiles } from "./metadata_repo_tree.ts";

describe("scanImports", () => {
  test("reads a bare import with a version", () => {
    const scan = scanImports('import * as w from "windmill-client@1.817.0";');
    expect(scan.bare).toEqual(["windmill-client@1.817.0"]);
  });

  test("reads a relative import", () => {
    expect(scanImports('import { a } from "./lib/a.ts";').local).toEqual([
      "./lib/a.ts",
    ]);
  });

  test("reads a rooted import of the workspace", () => {
    expect(
      scanImports('import { a } from "/f/factory/lib/a.ts";').local,
    ).toEqual(["/f/factory/lib/a.ts"]);
  });

  test("reads an import split over lines", () => {
    const code = 'import {\n  a,\n  b,\n} from "./lib/a.ts";\n';
    expect(scanImports(code).local).toEqual(["./lib/a.ts"]);
  });

  test("reads an export from", () => {
    expect(scanImports('export * from "./a.ts";').local).toEqual(["./a.ts"]);
  });

  test("reads an import for its side effect", () => {
    expect(scanImports('import "./a.ts";').local).toEqual(["./a.ts"]);
  });

  test("reads a dynamic import with a literal", () => {
    expect(scanImports('const m = await import ("./a.ts");').local).toEqual([
      "./a.ts",
    ]);
  });

  test.each([
    [
      "a second argument that is an object",
      'import("./m.ts", { with: { type: "macro" } });',
    ],
    ["a second argument written after a space", 'import("./m.ts" , {});'],
    ["a trailing comma", 'import("./m.ts",);'],
    ["a require call with a second argument", 'require("./m.ts", 1);'],
  ])("marks a call with %s as untraceable", (_name, code) => {
    expect(scanImports(code).untraceable).toBe(true);
  });

  test("reads a require call with a literal", () => {
    expect(scanImports('const m = require("left-pad@1.3.0");').bare).toEqual([
      "left-pad@1.3.0",
    ]);
  });

  test("reads an import type", () => {
    expect(scanImports('import type { T } from "./t.ts";').local).toEqual([
      "./t.ts",
    ]);
  });

  test("ignores node and bun builtins", () => {
    const scan = scanImports('import fs from "node:fs";\nimport "bun:test";');
    expect(scan.bare).toEqual([]);
  });

  test("ignores a string that is not an import", () => {
    expect(scanImports('const a = "./a.ts"; log("x/y");').local).toEqual([]);
  });

  test("keeps an import after a lone quote in a comment", () => {
    const code = '// don\'t do this\nimport "./a.ts";\n';
    expect(scanImports(code).local).toEqual(["./a.ts"]);
  });

  test.each([
    ["a variable", "const m = await import(name);"],
    ["a template literal", "await import(`./\x24{x}.ts`);"],
    ["a variable in a require call", "const m = require(name);"],
    ["a call over lines", "await import(\n  name\n);"],
    ["a concatenation after a literal", 'await import("a" + b);'],
    ["a concatenation of a relative path", 'await import("./x" + n);'],
    ["a method call on the literal", 'require("a".concat(b));'],
    ["a conditional after the literal", 'await import("a" ? b : c);'],
    ["a require call on import.meta", 'const m = import.meta.require("x");'],
    ["a require method on an object", 'loader.require("x");'],
    ["a require method after a line break", 'loader\n  .require("x");'],
    ["an optional call", 'loader?.require("x");'],
  ])("marks %s as untraceable", (_label, code) => {
    expect(scanImports(code).untraceable).toBe(true);
  });

  test.each([
    ["the user scripts", 'import x from "/u/admin/secret";'],
    ["an absolute path outside the tree", 'import x from "/etc/passwd";'],
    ["a root path", 'import x from "/x.ts";'],
  ])("marks an import of %s as untraceable", (_label, code) => {
    expect(scanImports(code).untraceable).toBe(true);
  });

  test("marks a literal followed by an options argument as untraceable", () => {
    expect(
      scanImports('await import("./a.ts", { with: { type: "json" } });')
        .untraceable,
    ).toBe(true);
  });

  test("does not mark a literal followed by a closing parenthesis and a call", () => {
    expect(scanImports('(await import("./a.ts")).main();').untraceable).toBe(
      false,
    );
  });

  test("does not mark plain code as untraceable", () => {
    expect(scanImports('import a from "./a.ts";\nlog(a);').untraceable).toBe(
      false,
    );
  });

  // 実時間が要る。病的な入力でも、importの走査が線形時間で終わることを、経過時間の上限で確かめる。
  // 上限は緩く、2乗の走査なら大きく超える。対象は、この`test.each`と、「linear time」の検査である。
  test.each([
    ["repeated import keywords", "import ".repeat(MAX_FILE_BYTES / 7)],
    ["white space after a keyword", `import${" ".repeat(MAX_FILE_BYTES - 6)}`],
    ["unpaired quotes", '"'.repeat(MAX_FILE_BYTES)],
    ["a long line of from keywords", 'from "'.repeat(MAX_FILE_BYTES / 6)],
    ["open parentheses", "import(".repeat(MAX_FILE_BYTES / 7)],
    ["braces after import", "import {".repeat(MAX_FILE_BYTES / 8)],
    [
      "white space before a call",
      `x${" ".repeat(MAX_FILE_BYTES - 20)}.require(`,
    ],
  ])("finishes quickly on %s", (_label, code) => {
    const started = performance.now();
    scanImports(code);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("scanImports with the transpiler", () => {
  test("detects an import hidden between quotes in comments", () => {
    const code = "/*'*/import x from \"evil\";/*'*/";
    expect(scanImports(code).bare).toEqual(["evil"]);
  });

  test("detects an import after a block comment with a quote", () => {
    const code = '/* it\'s */ import x from "evil2";';
    expect(scanImports(code).bare).toEqual(["evil2"]);
  });

  test("ignores an import in a line comment", () => {
    expect(scanImports('// import x from "commented";\n').bare).toEqual([]);
  });

  test("ignores an import in a block comment", () => {
    expect(scanImports('/* import y from "block"; */').bare).toEqual([]);
  });

  test("ignores an import in a string", () => {
    expect(scanImports('const s = "import x from \\"instr\\"";').bare).toEqual(
      [],
    );
  });

  test("ignores an import in a template literal", () => {
    expect(scanImports('const s = `import x from "intpl"`;').bare).toEqual([]);
  });

  test("reads an import whose braces hold only type modifiers", () => {
    expect(
      scanImports('import { type X } from "type-modifier-only";').bare,
    ).toEqual(["type-modifier-only"]);
  });

  test("reads an import with a type modifier and a value", () => {
    expect(
      scanImports('import { type X, y } from "type-and-value";').bare,
    ).toEqual(["type-and-value"]);
  });

  test("reads an import that is used only in a type position", () => {
    const code = 'import { Foo } from "type-position";\nlet a: Foo;';
    expect(scanImports(code).bare).toEqual(["type-position"]);
  });

  test("reads an import type of a package", () => {
    expect(scanImports('import type { T } from "import-type";').bare).toEqual([
      "import-type",
    ]);
  });

  test("reads a type-only export as an edge", () => {
    expect(scanImports('export type { T } from "./t.ts";').local).toEqual([
      "./t.ts",
    ]);
  });

  test("reads an import in a type position", () => {
    expect(
      scanImports('type A = typeof import("typeof-import");').bare,
    ).toEqual(["typeof-import"]);
  });

  test.each([
    ["a macro attribute", 'import { m } from "./m.ts" with { type: "macro" };'],
    ["a json attribute", 'import j from "./a.json" with { type: "json" };'],
    [
      "an assert attribute",
      'import j from "./a.json" assert { type: "json" };',
    ],
    [
      "an attribute split over lines",
      'import m from "./m.ts" with\n{ type: "macro" };',
    ],
    [
      "a block comment before the attribute",
      'import m from "./m.ts" /* c */ with { type: "macro" };',
    ],
    [
      "a block comment after the keyword",
      'import m from "./m.ts" with/* c */{ type: "macro" };',
    ],
    [
      "a line comment before the attribute",
      'import m from "./m.ts" // c\nwith { type: "macro" };',
    ],
    [
      "a line comment after the keyword",
      'import m from "./m.ts" with // c\n{ type: "macro" };',
    ],
    [
      "an assert attribute with a comment",
      'import m from "./m.ts" assert /* c */ { type: "macro" };',
    ],
    [
      "an unterminated comment after the keyword",
      'import m from "./m.ts" with /* c { type: "macro" };',
    ],
  ])("marks %s as untraceable", (_label, code) => {
    expect(scanImports(code).untraceable).toBe(true);
  });

  test.each([
    ["the word without", "const without = 1;"],
    ["a name that starts with with", "function withdraw() {}\nwithdraw();"],
    ["the word in a string", 'const s = "deal with it";'],
    ["the word in a comment", "// work with care\n"],
    ["assert used as a function", "assert(value);\nassert.ok(value);"],
    ["an import of assert", 'import assert from "node:assert";'],
    ["a word followed by a colon", "const o = { with: 1, assert: 2 };"],
  ])("does not mark %s as untraceable", (_label, code) => {
    expect(scanImports(code).untraceable).toBe(false);
  });

  test("does not run a macro while it scans a source with an attribute", () => {
    const dir = mkdtempSync(join(tmpdir(), "macro-"));
    const marker = join(dir, "ran");
    const macro = join(dir, "m.ts");
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport function m() { return 1; }\n`,
    );
    const code = `import { m } from ${JSON.stringify(macro)} with { type: "macro" };\nm();\n`;
    try {
      scanImports(code);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scans a megabyte of keywords in linear time", () => {
    const code = `${"with ".repeat(200_000)}x`;
    const started = performance.now();
    scanImports(code);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("does not run a macro behind a comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "macro-"));
    const marker = join(dir, "ran");
    const macro = join(dir, "m.ts");
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport function m() { return 1; }\n`,
    );
    const code = `import { m } from ${JSON.stringify(macro)} /* c */ with { type: "macro" };\nm();\n`;
    try {
      scanImports(code);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not read the imports of a source with an attribute", () => {
    const code = 'import { m } from "./m.ts" with { type: "macro" };';
    expect(scanImports(code).local).toEqual([]);
  });

  test("marks a source that does not parse as untraceable", () => {
    expect(scanImports("import import import").untraceable).toBe(true);
  });

  test("marks a call inside a comment as untraceable", () => {
    expect(scanImports("// import(name)\n").untraceable).toBe(true);
  });

  test("marks a call inside a string as untraceable", () => {
    expect(scanImports('const s = "require(x)";').untraceable).toBe(true);
  });

  test("reads a call with a literal inside a comment as traceable", () => {
    expect(scanImports('// import("./a.ts")\n').untraceable).toBe(false);
  });
});

describe("scanImports on the repository", () => {
  test("reads every source under f as traceable", async () => {
    const untraceable: string[] = [];
    for await (const path of new Bun.Glob("f/**/*.ts").scan(".")) {
      if (scanImports(readFileSync(path, "utf8")).untraceable) {
        untraceable.push(path);
      }
    }
    expect(untraceable).toEqual([]);
  });
});

const SOURCES: ReadonlySet<string> = new Set([
  "f/factory/a.ts",
  "f/factory/lib/b.ts",
  "f/factory/lib/c/index.ts",
  "f/factory/lib/d.ts",
]);

describe("resolveLocal", () => {
  test("resolves a relative specifier with its extension", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/b.ts", SOURCES)).toBe(
      "f/factory/lib/b.ts",
    );
  });

  test("completes the extension", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/b", SOURCES)).toBe(
      "f/factory/lib/b.ts",
    );
  });

  test("maps a js extension to ts", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/b.js", SOURCES)).toBe(
      "f/factory/lib/b.ts",
    );
  });

  test("resolves a directory to its index", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/c", SOURCES)).toBe(
      "f/factory/lib/c/index.ts",
    );
  });

  test("resolves a rooted specifier to the workspace", () => {
    expect(resolveLocal("f/factory/a.ts", "/f/factory/lib/d.ts", SOURCES)).toBe(
      "f/factory/lib/d.ts",
    );
  });

  test("resolves the same file from a relative and a rooted specifier", () => {
    expect(resolveLocal("f/factory/lib/b.ts", "./d.ts", SOURCES)).toBe(
      resolveLocal("f/factory/a.ts", "/f/factory/lib/d.ts", SOURCES),
    );
  });

  test("does not resolve a file that is not in the list", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/none.ts", SOURCES)).toBeNull();
  });

  test("does not resolve a decoy without an extension", () => {
    expect(resolveLocal("f/factory/a.ts", "./lib/decoy", SOURCES)).toBeNull();
  });

  test("does not resolve a path that leaves the tree", () => {
    expect(resolveLocal("f/a.ts", "../../x.ts", SOURCES)).toBeNull();
  });

  test.each([["/u/admin/x"], ["/etc/passwd"], ["/factory/a.ts"]])(
    "does not resolve the specifier %s",
    (specifier) => {
      expect(resolveLocal("f/factory/a.ts", specifier, SOURCES)).toBeNull();
    },
  );
});

function scannerOf(files: Record<string, string | "failed">) {
  const reads: string[] = [];
  const read = async (path: string): Promise<FileRead> => {
    reads.push(path);
    const value = files[path];
    if (value === undefined) {
      return { kind: "missing" };
    }
    if (value === "failed") {
      return { kind: "failed" };
    }
    return { kind: "found", content: new TextEncoder().encode(value) };
  };
  return { scan: createFileScanner(read), reads };
}

function sourcesOf(files: Record<string, unknown>): ReadonlySet<string> {
  return new Set(Object.keys(files));
}

describe("traceBareImports", () => {
  test("collects the bare imports through local imports", async () => {
    const files = {
      "f/a.ts": 'import "./b.ts";\nimport "left-pad@1.3.0";',
      "f/b.ts": 'import "./lib/c";\nimport "is-odd@1.0.0";',
      "f/lib/c.ts": 'import "is-even@2.0.0";',
    };
    const { scan } = scannerOf(files);
    const result = await traceBareImports("f/a.ts", scan, sourcesOf(files));
    expect(result.ok && [...result.bare].sort()).toEqual([
      "is-even@2.0.0",
      "is-odd@1.0.0",
      "left-pad@1.3.0",
    ]);
  });

  test("stops when the shared visit budget runs out", async () => {
    const files = {
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": 'import "./c.ts";',
      "f/c.ts": 'import "x@1.0.0";',
    };
    const { scan } = scannerOf(files);
    const result = await traceBareImports("f/a.ts", scan, sourcesOf(files), {
      remaining: 2,
    });
    expect(result.ok ? "ok" : result.reason).toBe("budget");
  });

  test("spends the shared visit budget across calls", async () => {
    const files = { "f/a.ts": 'import "x@1.0.0";' };
    const { scan } = scannerOf(files);
    const budget = { remaining: 10 };
    await traceBareImports("f/a.ts", scan, sourcesOf(files), budget);
    await traceBareImports("f/a.ts", scan, sourcesOf(files), budget);
    expect(budget.remaining).toBe(8);
  });

  test("follows a rooted import", async () => {
    const files = {
      "f/a.ts": 'import "/f/lib/c.ts";',
      "f/lib/c.ts": 'import "x@1.0.0";',
    };
    const { scan } = scannerOf(files);
    const result = await traceBareImports("f/a.ts", scan, sourcesOf(files));
    expect(result.ok && [...result.bare]).toEqual(["x@1.0.0"]);
  });

  test("resolves an index file", async () => {
    const files = {
      "f/a.ts": 'import "./lib";',
      "f/lib/index.ts": 'import "x@1.0.0";',
    };
    const { scan } = scannerOf(files);
    const result = await traceBareImports("f/a.ts", scan, sourcesOf(files));
    expect(result.ok && [...result.bare]).toEqual(["x@1.0.0"]);
  });

  test("stops at a cycle", async () => {
    const files = {
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": 'import "./a.ts";\nimport "x@1.0.0";',
    };
    const { scan } = scannerOf(files);
    const result = await traceBareImports("f/a.ts", scan, sourcesOf(files));
    expect(result.ok && [...result.bare]).toEqual(["x@1.0.0"]);
  });

  test("returns no imports for a missing entry", async () => {
    const { scan } = scannerOf({});
    const result = await traceBareImports("f/a.ts", scan, new Set());
    expect(result.ok && result.bare.size).toBe(0);
  });

  test("marks a local import that resolves to nothing as untraceable", async () => {
    const files = { "f/a.ts": 'import "./gone.ts";' };
    const { scan } = scannerOf(files);
    expect(await traceBareImports("f/a.ts", scan, sourcesOf(files))).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("does not read a decoy without an extension", async () => {
    const files = {
      "f/a.ts": 'import "./decoy";',
      "f/decoy": 'import "evil@1.0.0";',
    };
    const { scan, reads } = scannerOf(files);
    await traceBareImports("f/a.ts", scan, new Set(["f/a.ts"]));
    expect(reads).not.toContain("f/decoy");
  });

  test("marks a user script import as untraceable", async () => {
    const files = { "f/a.ts": 'import "/u/admin/x";' };
    const { scan } = scannerOf(files);
    expect(await traceBareImports("f/a.ts", scan, sourcesOf(files))).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("skips a file of the list that this tree does not have", async () => {
    const files = { "f/a.ts": 'import "./b.ts";' };
    const { scan } = scannerOf(files);
    const result = await traceBareImports(
      "f/a.ts",
      scan,
      new Set(["f/a.ts", "f/b.ts"]),
    );
    expect(result.ok).toBe(true);
  });

  test("fails when a file cannot be read", async () => {
    const files = { "f/a.ts": 'import "./b.ts";', "f/b.ts": "failed" as const };
    const { scan } = scannerOf(files);
    expect(await traceBareImports("f/a.ts", scan, sourcesOf(files))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  test("fails on an import that cannot be followed", async () => {
    const files = {
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": "await import(name);",
    };
    const { scan } = scannerOf(files);
    expect(await traceBareImports("f/a.ts", scan, sourcesOf(files))).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("fails on a file over the size limit", async () => {
    const files = { "f/a.ts": " ".repeat(MAX_FILE_BYTES + 1) };
    const { scan } = scannerOf(files);
    expect(await traceBareImports("f/a.ts", scan, sourcesOf(files))).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("fails on a file that is not text", async () => {
    const scan = createFileScanner(
      async (): Promise<FileRead> => ({
        kind: "found",
        content: new Uint8Array([0xff, 0xfe]),
      }),
    );
    expect(await traceBareImports("f/a.ts", scan, new Set(["f/a.ts"]))).toEqual(
      {
        ok: false,
        reason: "untraceable",
      },
    );
  });
});

describe("createFileScanner", () => {
  test("reads and scans a file once however many times it is asked", async () => {
    const { scan, reads } = scannerOf({ "f/a.ts": 'import "x@1.0.0";' });
    await scan("f/a.ts");
    await scan("f/a.ts");
    await scan("f/a.ts");
    expect(reads).toEqual(["f/a.ts"]);
  });

  test("shares the scan between traces of different entries", async () => {
    const files = {
      "f/a.ts": 'import "./lib.ts";',
      "f/b.ts": 'import "./lib.ts";',
      "f/lib.ts": 'import "x@1.0.0";',
    };
    const { scan, reads } = scannerOf(files);
    const sources = sourcesOf(files);
    await traceBareImports("f/a.ts", scan, sources);
    await traceBareImports("f/b.ts", scan, sources);
    expect(reads.filter((path) => path === "f/lib.ts")).toHaveLength(1);
  });
});

// 実行時に残るimportだけを数える読み方(`runtimeOnly`)。
// Windmillのlockは、型だけのimportと、使われないimportの先の依存を含めない。
describe("metadata_patch_imports runtime", () => {
  const runtime = (code: string) => scanImports(code, { runtimeOnly: true });

  describe("scanImports with runtimeOnly", () => {
    test("ignores an import type", () => {
      expect(runtime('import type { T } from "./t.ts";').local).toEqual([]);
    });

    test("ignores an import whose braces hold only type modifiers", () => {
      expect(runtime('import { type X } from "type-only";').bare).toEqual([]);
    });

    test("ignores an import that is used only in a type position", () => {
      const code = 'import { Foo } from "type-position";\nlet a: Foo;';
      expect(runtime(code).bare).toEqual([]);
    });

    test("ignores an import that is not used", () => {
      expect(runtime('import { Foo } from "unused-import";').bare).toEqual([]);
    });

    test("ignores a type-only export", () => {
      expect(runtime('export type { T } from "./t.ts";').local).toEqual([]);
    });

    test("reads an import that is used as a value", () => {
      const code = 'import { Foo } from "value-use";\nexport const a = Foo;';
      expect(runtime(code).bare).toEqual(["value-use"]);
    });

    test("reads an import with a type modifier and a value that is used", () => {
      const code =
        'import { type X, y } from "type-and-value";\nexport const v = y;';
      expect(runtime(code).bare).toEqual(["type-and-value"]);
    });

    test("reads a side effect import", () => {
      expect(runtime('import "side-effect";').bare).toEqual(["side-effect"]);
    });

    test("reads a value re-export as an edge", () => {
      expect(runtime('export { T } from "./t.ts";').local).toEqual(["./t.ts"]);
    });

    test("reads a dynamic import in a type position on the safe side", () => {
      expect(runtime('type A = typeof import("typeof-import");').bare).toEqual([
        "typeof-import",
      ]);
    });

    test("still refuses an import attribute", () => {
      expect(
        runtime('import { m } from "./m.ts" with { type: "macro" };')
          .untraceable,
      ).toBe(true);
    });

    test("keeps the type-only import when the default reading is used", () => {
      expect(scanImports('import type { T } from "./t.ts";').local).toEqual([
        "./t.ts",
      ]);
    });
  });

  describe("traceBareImports with runtimeOnly", () => {
    const files: Record<string, string> = {
      "f/a.ts": 'import type { T } from "./b.ts";\nexport type U = T;',
      "f/b.ts": 'import "left-pad@1.3.0";',
    };
    const sources = new Set(Object.keys(files));
    const read = async (path: string) => {
      const content = files[path];
      return content === undefined
        ? ({ kind: "missing" } as const)
        : ({
            kind: "found",
            content: new TextEncoder().encode(content),
          } as const);
    };

    test("does not follow a type-only import", async () => {
      const result = await traceBareImports(
        "f/a.ts",
        createFileScanner(read, { runtimeOnly: true }),
        sources,
      );
      expect(result.ok && [...result.bare]).toEqual([]);
    });

    test("follows the same import when it becomes a value import", async () => {
      files["f/a.ts"] = 'import { T } from "./b.ts";\nexport const u = T;';
      const result = await traceBareImports(
        "f/a.ts",
        createFileScanner(read, { runtimeOnly: true }),
        sources,
      );
      expect(result.ok && [...result.bare]).toEqual(["left-pad@1.3.0"]);
    });
  });

  describe("scanImports with runtimeOnly on other shapes of import", () => {
    test("reads a re-export of a package", () => {
      expect(runtime('export { x } from "pkg";').bare).toEqual(["pkg"]);
    });

    test("reads a star re-export of a package", () => {
      expect(runtime('export * from "pkg";').bare).toEqual(["pkg"]);
    });

    test("reads a star re-export of a local file as an edge", () => {
      expect(runtime('export * from "./x.ts";').local).toEqual(["./x.ts"]);
    });

    test("reads a default import that is used as a value", () => {
      expect(
        runtime('import d from "pkg-default";\nexport const v = d;').bare,
      ).toEqual(["pkg-default"]);
    });

    test("reads a namespace import that is used as a value", () => {
      expect(
        runtime('import * as ns from "pkg-ns";\nexport const v = ns.x;').bare,
      ).toEqual(["pkg-ns"]);
    });

    test("reads a dynamic import in an ordinary position", () => {
      expect(runtime('const m = await import("pkg-dynamic");').bare).toEqual([
        "pkg-dynamic",
      ]);
    });

    test("reads an import that is exported again by name", () => {
      expect(runtime('import { a } from "x";\nexport { a };').bare).toEqual([
        "x",
      ]);
    });
  });

  describe("a macro import is never executed while the imports are read", () => {
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
    };

    /** マクロは、印のファイルを書く。印ができたら、importを読む処理がマクロを実行したことになる。 */
    function macroProbe(): {
      dir: string;
      marker: string;
      make: (gap: string, keyword: string) => string;
    } {
      const dir = mkdtempSync(join(tmpdir(), "macro-probe-"));
      const marker = join(dir, "marker");
      const macro = join(dir, "m.ts");
      writeFileSync(
        macro,
        `import { writeFileSync } from "node:fs";\nexport function f() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`,
      );
      return {
        dir,
        marker,
        make: (gap, keyword) =>
          `import { f } from ${JSON.stringify(macro)} ${keyword}${gap}{ type: "macro" };\nexport const x = f();\n`,
      };
    }

    test.each(Object.entries(SPACES))(
      "does not run a macro that follows with and %s",
      (_name, gap) => {
        const probe = macroProbe();
        try {
          scanImports(probe.make(gap, "with"), { runtimeOnly: true });
          expect(existsSync(probe.marker)).toBe(false);
        } finally {
          rmSync(probe.dir, { recursive: true, force: true });
        }
      },
    );

    test.each(Object.entries(SPACES))(
      "does not run a macro that follows assert and %s",
      (_name, gap) => {
        const probe = macroProbe();
        try {
          scanImports(probe.make(gap, "assert"), { runtimeOnly: true });
          expect(existsSync(probe.marker)).toBe(false);
        } finally {
          rmSync(probe.dir, { recursive: true, force: true });
        }
      },
    );

    const RAW_VARIANTS = Object.entries(SPACES).flatMap(([name, gap]) =>
      (["with", "assert"] as const).map(
        (keyword) => [`${keyword} and ${name}`, gap, keyword] as const,
      ),
    );

    test.each(RAW_VARIANTS)(
      "does not run a macro when the Bun transpiler alone scans the imports after %s",
      (_name, gap, keyword) => {
        const probe = macroProbe();
        try {
          new Bun.Transpiler({ loader: "ts" }).scanImports(
            probe.make(gap, keyword),
          );
          expect(existsSync(probe.marker)).toBe(false);
        } finally {
          rmSync(probe.dir, { recursive: true, force: true });
        }
      },
    );

    test.each(RAW_VARIANTS)(
      "does not run a macro when the trimming Bun transpiler alone scans the imports after %s",
      (_name, gap, keyword) => {
        const probe = macroProbe();
        try {
          new Bun.Transpiler({
            loader: "ts",
            trimUnusedImports: true,
          }).scanImports(probe.make(gap, keyword));
          expect(existsSync(probe.marker)).toBe(false);
        } finally {
          rmSync(probe.dir, { recursive: true, force: true });
        }
      },
    );

    // 対照。同じ入力を`transformSync`に通すと、マクロが実行されて印ができる。
    // 印のファイルの作り方やimportの書き方が誤っていると、上の「印ができない」テストは常に緑になる。
    test.each([
      ["with and a space", " ", "with"],
      ["assert and a space", " ", "assert"],
      ["with and a vertical tab", String.fromCharCode(0x0b), "with"],
      ["with and a no-break space", String.fromCharCode(0xa0), "with"],
    ] as const)(
      "control: transformSync runs the macro that follows %s",
      (_name, gap, keyword) => {
        const probe = macroProbe();
        try {
          new Bun.Transpiler({ loader: "ts" }).transformSync(
            probe.make(gap, keyword),
          );
          expect(existsSync(probe.marker)).toBe(true);
        } finally {
          rmSync(probe.dir, { recursive: true, force: true });
        }
      },
    );

    test.each(Object.entries(SPACES))(
      "marks an import attribute after with and %s as untraceable",
      (_name, gap) => {
        const code = `import j from "./a.json" with${gap}{ type: "json" };`;
        expect(scanImports(code, { runtimeOnly: true }).untraceable).toBe(true);
      },
    );

    // `-->`は`transformSync`が読んでマクロを実行する(実測した)。
    // `<!--`は今のBunでは構文エラーだが、版が変わっても安全なよう断る側に倒す。
    test.each([
      ["with and an html close comment", "with", "\n--> c\n"],
      ["assert and an html close comment", "assert", "\n--> c\n"],
      ["with and an html open comment", "with", "\n<!-- c\n"],
    ] as const)(
      "marks an import attribute after %s as untraceable",
      (_name, keyword, gap) => {
        const code = `import j from "./a.json" ${keyword}${gap}{ type: "json" };`;
        expect(scanImports(code, { runtimeOnly: true }).untraceable).toBe(true);
      },
    );

    test("does not mark an English sentence that contains the word with as untraceable", () => {
      const code =
        'export const p = "Reply with a short answer, as with the others.";';
      expect(scanImports(code, { runtimeOnly: true }).untraceable).toBe(false);
    });
  });

  describe("the self check of the runtime reading", () => {
    test("passes with the real reading", () => {
      expect(runtimeScanSelfCheck()).toBe(true);
    });

    test("fails when a type-only import is read as a dependency", () => {
      const wrong = (code: string) => scanImports(code);
      expect(runtimeScanSelfCheck(wrong)).toBe(false);
    });

    test("fails when a re-export is not read", () => {
      const blind = (code: string) =>
        code.includes("export")
          ? { local: [], bare: [], untraceable: false }
          : scanImports(code, { runtimeOnly: true });
      expect(runtimeScanSelfCheck(blind)).toBe(false);
    });

    test("fails when a namespace import is not read", () => {
      const blind = (code: string) =>
        code.includes("* as")
          ? { local: [], bare: [], untraceable: false }
          : scanImports(code, { runtimeOnly: true });
      expect(runtimeScanSelfCheck(blind)).toBe(false);
    });

    test("fails when a dynamic import is not read", () => {
      const blind = (code: string) =>
        code.includes("await")
          ? { local: [], bare: [], untraceable: false }
          : scanImports(code, { runtimeOnly: true });
      expect(runtimeScanSelfCheck(blind)).toBe(false);
    });

    test("fails when an import attribute is not refused in advance", () => {
      const lenient = (code: string) =>
        code.includes('type: "json"')
          ? { local: [], bare: [], untraceable: false }
          : scanImports(code, { runtimeOnly: true });
      expect(runtimeScanSelfCheck(lenient)).toBe(false);
    });

    test("fails when a value import is not read", () => {
      const nothing = () => ({ local: [], bare: [], untraceable: false });
      expect(runtimeScanSelfCheck(nothing)).toBe(false);
    });
  });

  describe("the file that holds many local specifiers", () => {
    test("is close to the size limit of one file", () => {
      const specifiers = Array.from(
        { length: 38_000 },
        (_unused, index) => `import "./${index}/../a.ts";`,
      ).join("\n");
      expect(specifiers.length).toBeGreaterThan(900_000);
    });
  });

  describe("traceBareImports and the shared budget", () => {
    test("counts every local specifier of a file against the budget", async () => {
      const specifiers = Array.from(
        { length: 38_000 },
        (_unused, index) => `import "./${index}/../a.ts";`,
      ).join("\n");
      const files: Record<string, string> = {
        "f/a.ts": specifiers,
      };
      const read = async (path: string) => {
        const content = files[path];
        return content === undefined
          ? ({ kind: "missing" } as const)
          : ({
              kind: "found",
              content: new TextEncoder().encode(content),
            } as const);
      };
      const budget = { remaining: 1000 };
      const result = await traceBareImports(
        "f/a.ts",
        createFileScanner(read, { runtimeOnly: true }),
        new Set(["f/a.ts"]),
        budget,
      );
      expect(result.ok ? "ok" : result.reason).toBe("budget");
    });

    test("stops resolving specifiers once the budget runs out", async () => {
      const specifiers = Array.from(
        { length: 38_000 },
        (_unused, index) => `import "./${index}/../a.ts";`,
      ).join("\n");
      const read = async () =>
        ({
          kind: "found",
          content: new TextEncoder().encode(specifiers),
        }) as const;
      const budget = { remaining: 1000 };
      await traceBareImports(
        "f/a.ts",
        createFileScanner(read, { runtimeOnly: true }),
        new Set(["f/a.ts"]),
        budget,
      );
      expect(budget.remaining).toBe(0);
    });
  });

  /** specifier(`pkg@1.0.0`、`@scope/pkg/sub`など)から、パッケージ名を取り出す。 */
  function packageName(specifier: string): string {
    const parts = specifier.split("/");
    const head = specifier.startsWith("@")
      ? `${parts[0]}/${parts[1]}`
      : (parts[0] ?? specifier);
    const at = head.lastIndexOf("@");
    return at > 0 ? head.slice(0, at) : head;
  }

  describe("runtime imports and the lock files of this repository", () => {
    const files = new Map(
      [...readRepoFiles()].filter(([path]) => path.startsWith("f/")),
    );
    const sources = new Set(
      [...files.keys()].filter((path) => path.endsWith(".ts")),
    );
    const read = async (path: string) => {
      const content = files.get(path);
      return content === undefined
        ? ({ kind: "missing" } as const)
        : ({ kind: "found", content } as const);
    };

    function lockDependencies(path: string): string[] | null {
      const lock = files.get(path.replace(/\.ts$/, ".script.lock"));
      if (lock === undefined) {
        return null;
      }
      const text = new TextDecoder().decode(lock);
      const front = text.split("\n//bun.lock\n")[0] ?? "";
      const parsed: unknown = JSON.parse(front);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("dependencies" in parsed) ||
        typeof parsed.dependencies !== "object" ||
        parsed.dependencies === null
      ) {
        return null;
      }
      return Object.keys(parsed.dependencies).sort();
    }

    test("the package names of the runtime closure equal the dependencies of every script.lock", async () => {
      const scan = createFileScanner(read, { runtimeOnly: true });
      const mismatched: string[] = [];
      for (const source of [...sources].sort()) {
        const expected = lockDependencies(source);
        if (expected === null) {
          continue;
        }
        const trace = await traceBareImports(source, scan, sources);
        const actual = trace.ok
          ? [...new Set([...trace.bare].map(packageName))].sort()
          : ["(untraceable)"];
        if (actual.join(",") !== expected.join(",")) {
          mismatched.push(source);
        }
      }
      expect(
        mismatched,
        `bun ${Bun.version}: the runtime closure of these scripts differs from the dependencies of their script.lock`,
      ).toEqual([]);
    });

    test("the calibration covers the scripts that have a lock", () => {
      const withLock = [...sources].filter(
        (source) => lockDependencies(source) !== null,
      );
      expect(withLock.length).toBeGreaterThan(100);
    });
  });
});
