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
  scanImports,
  traceBareImports,
} from "../../f/factory/lib/metadata_patch_imports.ts";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";

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
