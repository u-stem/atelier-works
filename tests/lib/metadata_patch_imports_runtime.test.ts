// 実行時に残るimportだけを数える読み方(`runtimeOnly`)。
// Windmillのlockは、型だけのimportと、使われないimportの先の依存を含めない。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileScanner,
  runtimeScanSelfCheck,
  scanImports,
  traceBareImports,
} from "../../f/factory/lib/metadata_patch_imports.ts";
import { readRepoFiles } from "./metadata_repo_tree.ts";

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
      runtime('import { m } from "./m.ts" with { type: "macro" };').untraceable,
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

  // 旧式のHTML風コメントは、`transformSync`が読んでマクロを実行する形である(実測した)。
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
