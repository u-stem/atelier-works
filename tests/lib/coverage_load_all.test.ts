import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTargetPath, listTargetFiles } from "../../scripts/check-coverage.ts";

// `f/factory/**`の対象を、テストがimportしなくてもカバレッジの分母に入れるため、
// 追跡している対象をすべて動的importで読み込む。bunは、読み込まれなかったファイルをlcovに出さない。
//
// 読み込む間は、`fetch`、`Bun.spawn`、`Bun.spawnSync`、`Bun.$`、`Bun.write`、`Bun.connect`、
// `Bun.serve`を、呼ばれたら記録して投げる関数に差し替え、読み込みの後に必ず戻す。
// 検出するのは、このテストが最初にそのモジュールを読み込んだときに、差し替えたAPIが同期で
// 呼ばれた場合だけである。別のテストが先に読み込んだモジュール(キャッシュから返る)、
// `node:child_process`、`import { spawn } from "bun"`の束縛、読み込みの後に動くコールバックは
// 検出しない。衛生のための検査で、セキュリティの境界ではない。
//
// 記録するのは、APIの名前と、読み込んでいたファイルのパスだけである。引数は記録しない。
// 読み込む対象は、追跡している(コミット済みかステージ済みの)ファイルに限る。
// 追跡していない新しいファイルは、`bun ./scripts/check-coverage.ts`が未読み込みとして止める。

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Guard = {
  readonly owner: object;
  readonly name: string;
  readonly label: string;
};

const GUARDS: readonly Guard[] = [
  { owner: globalThis, name: "fetch", label: "fetch" },
  { owner: Bun, name: "spawn", label: "Bun.spawn" },
  { owner: Bun, name: "spawnSync", label: "Bun.spawnSync" },
  { owner: Bun, name: "$", label: "Bun.$" },
  { owner: Bun, name: "write", label: "Bun.write" },
  { owner: Bun, name: "connect", label: "Bun.connect" },
  { owner: Bun, name: "serve", label: "Bun.serve" },
];

type LoadResult = {
  /** 読み込めなかったパスと理由。 */
  readonly failures: readonly string[];
  /** 差し替えたAPIが、読み込みの間に呼ばれた記録。 */
  readonly violations: readonly string[];
};

/** パスを出力に載せてよい形にする。対象の形に合わなければ載せない。 */
function labelOf(path: string): string {
  return isTargetPath(path) ? path : "<path outside the target>";
}

/**
 * `paths`(`root`からの相対パス)を1つずつ読み込む。差し替えは読み込みの前に入れ、
 * `finally`で戻す。symlinkは読み込まずに失敗として数える。
 */
async function loadModules(
  root: string,
  paths: readonly string[],
): Promise<LoadResult> {
  const failures: string[] = [];
  const violations: string[] = [];
  const originals = GUARDS.map(({ owner, name }) => Reflect.get(owner, name));
  let loading = "";
  try {
    for (const { owner, name, label } of GUARDS) {
      const replaced = (): never => {
        violations.push(
          `${label} was called while loading ${labelOf(loading)}`,
        );
        throw new Error(`${label} is not allowed while loading a module`);
      };
      Reflect.set(owner, name, replaced);
    }
    for (const path of paths) {
      const absolute = join(root, path);
      if (lstatSync(absolute).isSymbolicLink()) {
        failures.push(`${labelOf(path)}: is a symlink`);
        continue;
      }
      loading = path;
      try {
        await import(absolute);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${labelOf(path)}: ${reason}`);
      }
    }
  } finally {
    GUARDS.forEach(({ owner, name }, index) => {
      Reflect.set(owner, name, originals[index]);
    });
  }
  return { failures, violations };
}

describe("every tracked f/factory target", () => {
  // 列挙を先に終え、差し替えは`loadModules`の中だけに入れる。
  const listed = listTargetFiles(ROOT, { includeUntracked: false }).targets;
  const paths = listed.filter((path) => path.startsWith("f/factory/"));
  let result: LoadResult = { failures: [], violations: [] };

  beforeAll(async () => {
    result = await loadModules(ROOT, paths);
  });

  test("lists the targets to load", () => {
    expect(paths.length).toBeGreaterThan(100);
  });

  test("passes no path under scripts to the importer", () => {
    expect(paths.filter((path) => path.startsWith("scripts/"))).toEqual([]);
  });

  test("loads without an import error", () => {
    expect(result.failures).toEqual([]);
  });

  test("loads without calling a guarded API", () => {
    expect(result.violations).toEqual([]);
  });
});

describe("loadModules", () => {
  let dir = "";

  function write(path: string, source: string): void {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "coverage-load-all-"));
    write("f/factory/fake/plain.ts", "export const x = 1;\n");
    write("f/factory/fake/throws.ts", 'throw new Error("boom");\n');
    write(
      "f/factory/fake/secret_arg.ts",
      'try { fetch("https://example.invalid/?token=SECRET"); } catch {}\n',
    );
    write("f/factory/fake/throws_again.ts", 'throw new Error("boom");\n');
    write(
      "f/factory/fake/restore_fetch.ts",
      "fetch('https://example.invalid');\n",
    );
    write("f/factory/fake/restore_spawn.ts", "Bun.spawn(['true']);\n");
    write(
      "f/factory/fake/call_fetch.ts",
      "fetch('https://example.invalid');\n",
    );
    write("f/factory/fake/call_spawn.ts", "Bun.spawn(['true']);\n");
    write("f/factory/fake/call_spawn_sync.ts", "Bun.spawnSync(['true']);\n");
    write("f/factory/fake/call_shell.ts", "Bun.$`true`;\n");
    write("f/factory/fake/call_write.ts", "Bun.write('/dev/null', '');\n");
    write("f/factory/fake/call_connect.ts", "Bun.connect({});\n");
    write("f/factory/fake/call_serve.ts", "Bun.serve({});\n");
    write("f/factory/fake/target.ts", "export const y = 1;\n");
    symlinkSync(
      join(dir, "f/factory/fake/target.ts"),
      join(dir, "f/factory/fake/link.ts"),
    );
  });

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("reports no failure for a plain module", async () => {
    const result = await loadModules(dir, ["f/factory/fake/plain.ts"]);

    expect(result).toEqual({ failures: [], violations: [] });
  });

  test.each([
    ["fetch", "f/factory/fake/call_fetch.ts"],
    ["Bun.spawn", "f/factory/fake/call_spawn.ts"],
    ["Bun.spawnSync", "f/factory/fake/call_spawn_sync.ts"],
    ["Bun.$", "f/factory/fake/call_shell.ts"],
    ["Bun.write", "f/factory/fake/call_write.ts"],
    ["Bun.connect", "f/factory/fake/call_connect.ts"],
    ["Bun.serve", "f/factory/fake/call_serve.ts"],
  ])(
    "records a call to %s with the path of the module",
    async (label, path) => {
      const result = await loadModules(dir, [path]);

      expect(result.violations).toEqual([
        `${label} was called while loading ${path}`,
      ]);
    },
  );

  test("keeps the arguments of a call out of the record", async () => {
    const result = await loadModules(dir, ["f/factory/fake/secret_arg.ts"]);

    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("reports an error thrown while loading", async () => {
    const result = await loadModules(dir, ["f/factory/fake/throws.ts"]);

    expect(result.failures).toEqual(["f/factory/fake/throws.ts: boom"]);
  });

  test("reports a symlink without loading it", async () => {
    const result = await loadModules(dir, ["f/factory/fake/link.ts"]);

    expect(result.failures).toEqual(["f/factory/fake/link.ts: is a symlink"]);
  });

  test("puts the original fetch back after loading", async () => {
    const original = globalThis.fetch;

    await loadModules(dir, ["f/factory/fake/restore_fetch.ts"]);

    expect(globalThis.fetch).toBe(original);
  });

  test("puts the original Bun.spawn back after loading", async () => {
    const original = Bun.spawn;

    await loadModules(dir, ["f/factory/fake/restore_spawn.ts"]);

    expect(Bun.spawn).toBe(original);
  });

  test("puts the originals back after a module fails to load", async () => {
    const original = Bun.write;

    await loadModules(dir, ["f/factory/fake/throws_again.ts"]);

    expect(Bun.write).toBe(original);
  });
});
