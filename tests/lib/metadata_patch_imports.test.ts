import { describe, expect, test } from "bun:test";
import {
  type FileRead,
  relativeCandidates,
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
    expect(scanImports('import { a } from "./lib/a.ts";').relative).toEqual([
      "./lib/a.ts",
    ]);
  });

  test("reads an import split over lines", () => {
    const code = 'import {\n  a,\n  b,\n} from "./lib/a.ts";\n';
    expect(scanImports(code).relative).toEqual(["./lib/a.ts"]);
  });

  test("reads an export from", () => {
    expect(scanImports('export * from "./a.ts";').relative).toEqual(["./a.ts"]);
  });

  test("reads an import for its side effect", () => {
    expect(scanImports('import "./a.ts";').relative).toEqual(["./a.ts"]);
  });

  test("reads a dynamic import with a literal", () => {
    expect(scanImports('const m = await import ("./a.ts");').relative).toEqual([
      "./a.ts",
    ]);
  });

  test("reads a require with a literal", () => {
    expect(scanImports('const m = require("left-pad@1.3.0");').bare).toEqual([
      "left-pad@1.3.0",
    ]);
  });

  test("reads an import type", () => {
    expect(scanImports('import type { T } from "./t.ts";').relative).toEqual([
      "./t.ts",
    ]);
  });

  test("ignores node and bun builtins", () => {
    const scan = scanImports('import fs from "node:fs";\nimport "bun:test";');
    expect(scan.bare).toEqual([]);
  });

  test("ignores a string that is not an import", () => {
    expect(scanImports('const a = "./a.ts"; log("x/y");').relative).toEqual([]);
  });

  test("ignores a property named from", () => {
    expect(scanImports('const a = obj.from "./a.ts";').relative).toEqual([]);
  });

  test("keeps an import after a lone quote in a comment", () => {
    const code = '// don\'t do this\nimport "./a.ts";\n';
    expect(scanImports(code).relative).toEqual(["./a.ts"]);
  });

  test.each([
    ["a variable in import()", "const m = await import(name);"],
    ["a template literal in import()", "await import(`./\x24{x}.ts`);"],
    ["a variable in require()", "const m = require(name);"],
    ["a call over lines", "await import(\n  name\n);"],
  ])("marks %s as untraceable", (_label, code) => {
    expect(scanImports(code).untraceable).toBe(true);
  });

  test("does not mark a method named require as untraceable", () => {
    expect(scanImports("loader.require(name);").untraceable).toBe(false);
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
  ])("finishes quickly on %s", (_label, code) => {
    const started = performance.now();
    scanImports(code);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("relativeCandidates", () => {
  test("lists the paths that a specifier can mean", () => {
    expect(relativeCandidates("f/factory/a.ts", "./lib/b")).toEqual([
      "f/factory/lib/b",
      "f/factory/lib/b.ts",
      "f/factory/lib/b/index.ts",
    ]);
  });

  test("maps a js extension to ts", () => {
    expect(relativeCandidates("f/factory/a.ts", "./b.js")).toContain(
      "f/factory/b.ts",
    );
  });

  test("drops a path that leaves the tree", () => {
    expect(relativeCandidates("f/a.ts", "../../x.ts")).toEqual([]);
  });
});

function reader(files: Record<string, string | "failed">) {
  const calls: string[] = [];
  const read = async (path: string): Promise<FileRead> => {
    calls.push(path);
    const value = files[path];
    if (value === undefined) {
      return { kind: "missing" };
    }
    if (value === "failed") {
      return { kind: "failed" };
    }
    return { kind: "found", content: new TextEncoder().encode(value) };
  };
  return { read, calls };
}

describe("traceBareImports", () => {
  test("collects the bare imports through relative imports", async () => {
    const { read } = reader({
      "f/a.ts": 'import "./b.ts";\nimport "left-pad@1.3.0";',
      "f/b.ts": 'import "./lib/c";\nimport "is-odd@1.0.0";',
      "f/lib/c.ts": 'import "is-even@2.0.0";',
    });
    const result = await traceBareImports("f/a.ts", read);
    expect(result.ok && [...result.bare].sort()).toEqual([
      "is-even@2.0.0",
      "is-odd@1.0.0",
      "left-pad@1.3.0",
    ]);
  });

  test("resolves an index file", async () => {
    const { read } = reader({
      "f/a.ts": 'import "./lib";',
      "f/lib/index.ts": 'import "x@1.0.0";',
    });
    const result = await traceBareImports("f/a.ts", read);
    expect(result.ok && [...result.bare]).toEqual(["x@1.0.0"]);
  });

  test("stops at a cycle", async () => {
    const { read } = reader({
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": 'import "./a.ts";\nimport "x@1.0.0";',
    });
    const result = await traceBareImports("f/a.ts", read);
    expect(result.ok && [...result.bare]).toEqual(["x@1.0.0"]);
  });

  test("returns no imports for a missing entry", async () => {
    const { read } = reader({});
    const result = await traceBareImports("f/a.ts", read);
    expect(result.ok && result.bare.size).toBe(0);
  });

  test("ignores a relative import that resolves to nothing", async () => {
    const { read } = reader({ "f/a.ts": 'import "./gone.ts";' });
    const result = await traceBareImports("f/a.ts", read);
    expect(result.ok).toBe(true);
  });

  test("fails when a file cannot be read", async () => {
    const { read } = reader({
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": "failed",
    });
    expect(await traceBareImports("f/a.ts", read)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  test("fails on an import that cannot be followed", async () => {
    const { read } = reader({
      "f/a.ts": 'import "./b.ts";',
      "f/b.ts": "await import(name);",
    });
    expect(await traceBareImports("f/a.ts", read)).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("fails on a file over the size limit", async () => {
    const { read } = reader({ "f/a.ts": " ".repeat(MAX_FILE_BYTES + 1) });
    expect(await traceBareImports("f/a.ts", read)).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });

  test("fails on a file that is not text", async () => {
    const read = async (): Promise<FileRead> => ({
      kind: "found",
      content: new Uint8Array([0xff, 0xfe]),
    });
    expect(await traceBareImports("f/a.ts", read)).toEqual({
      ok: false,
      reason: "untraceable",
    });
  });
});
