import { describe, expect, test } from "bun:test";
import {
  relative,
  sourcesReachableFrom,
  transpiler,
} from "./worker_boundary_scan.ts";

// GitHub読み取りの共通の収集は、fsにもサブプロセスにも触れない定期ジョブ用workerで動く。
// 収集が使うモジュールのimportでたどれるソースに、次のモジュールのimportが無いことを固定する。
// - ファイル: node:fs、fs、node:fs/promises
// - OSとパス: node:os、os、node:path、path
// - サブプロセス: node:child_process、child_process
// 型だけのimportは実行時に消えるので、たどらない。
// 走査の方法と限界は、`console_worker_boundary.test.ts`の先頭にある。

const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
  "node:os",
  "os",
  "node:path",
  "path",
  "node:child_process",
  "child_process",
]);

/** `entry`がimportでたどれるソースのうち、禁止のモジュールをimportしているものを`file: module`の形で返す。 */
function forbiddenImportsReachableFrom(entry: string): string[] {
  const found: string[] = [];
  for (const [file, source] of sourcesReachableFrom(entry)) {
    for (const { path } of transpiler.scanImports(source)) {
      if (FORBIDDEN_MODULES.has(path)) {
        found.push(`${relative(file)}: ${path}`);
      }
    }
  }
  return found.sort();
}

describe("modules used by the shared GitHub collection", () => {
  test.each([
    "f/factory/lib/config",
    "f/factory/lib/owner_id_gate",
    "f/factory/lib/gh_errors",
    "f/factory/lib/job_tmp_limits",
  ])(
    "the import closure of %s has no file, OS, path or process module",
    (entry) => {
      expect(forbiddenImportsReachableFrom(entry)).toEqual([]);
    },
  );
});

describe("import scan of the boundary test", () => {
  test("finds a file module imported at runtime", () => {
    expect(forbiddenImportsReachableFrom("f/factory/lib/job_tmp")).toContain(
      "f/factory/lib/job_tmp.ts: node:fs",
    );
  });

  test("ignores a module imported for its types only", () => {
    const source = `import type { Stats } from "node:fs";\nexport type S = Stats;`;
    expect(transpiler.scanImports(source).map((entry) => entry.path)).toEqual(
      [],
    );
  });
});
