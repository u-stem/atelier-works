import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 共通の小さな関数を、決まった末端モジュールの外で定義し直していないことを固定する。
// 末端モジュールは他のファイルをimportしないので、どの境界の内側からも読める。
// 定義を残してよいのは、import先が境界で限られるファイルだけで、理由を表に書く。

const ROOT = join(import.meta.dir, "..", "..");

function trackedTypeScriptFiles(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } },
  );
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** `name`を関数か定数として定義しているファイル。入れ子の定義も数える。 */
function filesDefining(name: string): string[] {
  const definition = new RegExp(
    String.raw`^\s*(?:export\s+)?(?:async\s+)?(?:function\s+${name}\b|const\s+${name}\s*=)`,
    "m",
  );
  return trackedTypeScriptFiles()
    .filter((path) => definition.test(read(path)))
    .sort();
}

// 保護パスの中だけを読むファイルの理由。保護されない共通のモジュールをimportすると、人のレビューを経ない変更が判定の入力になる。
const PROTECTED_CLOSURE =
  "the hold command and the merge guard reach only protected paths";
const PROTECTED_LEAF =
  "a protected path whose imports are all protected keeps its own copy";

/** `isRecord`を定義してよいファイルと、その理由。 */
const IS_RECORD_HOMES: Readonly<Record<string, string>> = {
  "f/factory/lib/types.ts": "the shared leaf module",
  "f/factory/lib/console_redact.ts":
    "the console worker scripts reach only protected paths",
  "f/factory/lib/freezes.ts": PROTECTED_CLOSURE,
  "f/factory/lib/stop_all.ts": PROTECTED_CLOSURE,
  "scripts/freeze.ts": PROTECTED_CLOSURE,
  "scripts/hold_psql.ts": PROTECTED_CLOSURE,
  "scripts/claude-hooks/hook-io.ts": PROTECTED_CLOSURE,
  "scripts/host_apply/stable.ts":
    "scripts/host_apply imports only built-ins and its own directory",
  "infra/console_fetcher/decide.ts":
    "the fetcher image copies only its own files",
  "f/factory/lib/metadata_patch_manifest.ts": PROTECTED_LEAF,
  "scripts/check-console-lockfile.ts": PROTECTED_LEAF,
  "scripts/check-script-locks.ts": PROTECTED_LEAF,
  "scripts/gen-console-known-paths.ts": PROTECTED_LEAF,
  "console/scripts/drawio-viewer.ts": PROTECTED_LEAF,
  "tests/lib/script_yaml_lock_contract.test.ts": PROTECTED_LEAF,
  "tests/scripts/claude-hooks/merge-guard.test.ts": PROTECTED_LEAF,
  "tests/scripts/claude-hooks/settings.test.ts": PROTECTED_LEAF,
};

/** `errorMessage`を定義してよいファイルと、その理由。`log.ts`の定義は、秘密情報を常にマスクする。 */
const ERROR_MESSAGE_HOMES: Readonly<Record<string, string>> = {
  "f/factory/lib/log.ts": "the shared leaf module",
  "f/factory/lib/freezes.ts": PROTECTED_CLOSURE,
  "f/factory/lib/freeze_apply.ts": PROTECTED_CLOSURE,
  "scripts/freeze.ts": PROTECTED_CLOSURE,
  "scripts/hold.ts": PROTECTED_CLOSURE,
};

describe("isRecord", () => {
  test("is defined only in types.ts and the files that cannot import it", () => {
    expect(filesDefining("isRecord")).toEqual(
      Object.keys(IS_RECORD_HOMES).sort(),
    );
  });
});

describe("errorMessage", () => {
  test("is defined only in log.ts and the files that cannot import it", () => {
    expect(filesDefining("errorMessage")).toEqual(
      Object.keys(ERROR_MESSAGE_HOMES).sort(),
    );
  });
});

describe("the shared leaf modules", () => {
  test.each(["f/factory/lib/types.ts", "f/factory/lib/log.ts"])(
    "%s imports nothing",
    (path) => {
      expect(read(path)).not.toMatch(/^\s*(?:import|export)\b[^;]*\bfrom\s+"/m);
    },
  );
});
