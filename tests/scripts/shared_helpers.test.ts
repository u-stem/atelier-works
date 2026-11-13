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

type BodyShape = {
  /** 戻り値の型。引数の名前は`\1`で参照する。 */
  readonly returnType: string;
  /** 返す式。引数の名前を`ARG`と書く。 */
  readonly body: string;
};

// 整形で改行や括弧が入っても拾えるよう、字句の間はどれも空白と改行を許す。
const ERROR_TEXT_EXPRESSION = String.raw`ARG\s+instanceof\s+Error\s*\?\s*ARG\.message\s*:\s*String\(\s*ARG\s*\)`;

/** 例外の文を取り出す本体。マスクの有無を問わない。 */
const ERROR_TEXT_SHAPE: BodyShape = {
  returnType: "string",
  body: String.raw`(?:maskSecrets\(\s*${ERROR_TEXT_EXPRESSION}\s*,?\s*\)|${ERROR_TEXT_EXPRESSION})`,
};

/** 配列でも`null`でもないオブジェクトを判定する本体。 */
const RECORD_SHAPE: BodyShape = {
  returnType: String.raw`\1\s+is\s+[^{=]+?`,
  body: String.raw`typeof\s+ARG\s*===\s*"object"\s*&&\s*ARG\s*!==\s*null\s*&&\s*!Array\.isArray\(\s*ARG\s*\)`,
};

/**
 * `source`が、`shape`の式だけを返す関数を、名前を問わず定義しているか。
 * 関数の宣言と、`const`に入れたアロー関数(式だけの本体と、`return`だけのブロック)を見る。
 * 式は括弧で包まれていてもよい。
 */
function definesBody(source: string, shape: BodyShape): boolean {
  const body = shape.body.replaceAll("ARG", String.raw`\1`);
  const returned = String.raw`(?:\(\s*${body}\s*\)|${body})`;
  const block = String.raw`\{\s*return\s+${returned}\s*;?\s*\}`;
  const parameter = String.raw`\(\s*(\w+)\s*:\s*unknown\s*,?\s*\)\s*:\s*${shape.returnType}\s*`;
  return [
    String.raw`function\s+\w+\s*${parameter}${block}`,
    String.raw`const\s+\w+\s*=\s*${parameter}=>\s*(?:${block}|${returned})`,
  ].some((pattern) => new RegExp(pattern).test(source));
}

/** `shape`の本体の関数を定義しているファイル。 */
function filesWithBody(shape: BodyShape): string[] {
  return trackedTypeScriptFiles()
    .filter((path) => definesBody(read(path), shape))
    .sort();
}

function filesWithErrorTextBody(): string[] {
  return filesWithBody(ERROR_TEXT_SHAPE);
}

function filesWithRecordBody(): string[] {
  return filesWithBody(RECORD_SHAPE);
}

/** `homes`の外で`name`を定義しているファイル。 */
function definedOutside(
  name: string,
  homes: Readonly<Record<string, string>>,
): string[] {
  return filesDefining(name).filter((path) => !(path in homes));
}

// 保護パスの中だけを読むファイルの理由。保護されない共通のモジュールをimportすると、人のレビューを経ない変更が判定の入力になる。
// 保留と凍結と全停止の部品は、保留のCLI、マージのフック、Console用workerのscriptが読み込むので、どれもこの閉包に入る。
const PROTECTED_CLOSURE =
  "the hold, freeze and stop-all files reach only protected paths, because the hold command, the merge guard and the console worker load them";
const DEPLOY_GATE_CLOSURE =
  "every file that the deploy gate imports is a protected path";
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
  "scripts/check-idle.ts":
    "a protected path that runs on the host reads no unprotected module that is edited every day",
  "f/factory/lib/console_actions.ts":
    "the console action log imports nothing, so that no unprotected module decides what it records",
  "f/factory/lib/metadata_patch_manifest.ts": PROTECTED_LEAF,
  "scripts/check-console-lockfile.ts": PROTECTED_LEAF,
  "scripts/check-script-locks.ts": PROTECTED_LEAF,
  "scripts/gen-console-known-paths.ts": PROTECTED_LEAF,
  "console/scripts/drawio-viewer.ts": PROTECTED_LEAF,
  "tests/lib/script_yaml_lock_contract.test.ts": PROTECTED_LEAF,
  "tests/scripts/claude-hooks/merge-guard.test.ts": PROTECTED_LEAF,
  "tests/scripts/claude-hooks/settings.test.ts": PROTECTED_LEAF,
};

/**
 * 例外の文を取り出す関数(`errorMessage`と、同じ本体の別の名前の関数)を定義してよいファイルと、その理由。
 * `log.ts`の定義は、秘密情報を常にマスクする。
 */
const ERROR_TEXT_HOMES: Readonly<Record<string, string>> = {
  "f/factory/lib/log.ts": "the shared leaf module",
  "f/factory/lib/freezes.ts": PROTECTED_CLOSURE,
  "f/factory/lib/freeze_apply.ts": PROTECTED_CLOSURE,
  "scripts/freeze.ts": PROTECTED_CLOSURE,
  "scripts/hold.ts": PROTECTED_CLOSURE,
  "f/factory/lib/deploy_gate.ts": DEPLOY_GATE_CLOSURE,
};

/** 日本時間とUTCの差を定義してよいファイルと、その理由。Consoleの`jst.ts`は`f/factory/lib/jst.ts`を読み直す。 */
const JST_OFFSET_HOMES: Readonly<Record<string, string>> = {
  "f/factory/lib/jst.ts": "the shared leaf module",
};

describe("definesBody", () => {
  test("finds a function declaration that returns the error text", () => {
    const source = [
      "function textOf(err: unknown): string {",
      "  return err instanceof Error ? err.message : String(err);",
      "}",
    ].join("\n");
    expect(definesBody(source, ERROR_TEXT_SHAPE)).toBe(true);
  });

  test("finds an arrow function whose expression is the error text", () => {
    const source = [
      "const textOf = (err: unknown): string =>",
      "  err instanceof Error ? err.message : String(err);",
    ].join("\n");
    expect(definesBody(source, ERROR_TEXT_SHAPE)).toBe(true);
  });

  test("finds an arrow function whose block returns the error text", () => {
    const source = [
      "const textOf = (err: unknown): string => {",
      "  return err instanceof Error ? err.message : String(err);",
      "};",
    ].join("\n");
    expect(definesBody(source, ERROR_TEXT_SHAPE)).toBe(true);
  });

  test("finds the masked error text that the formatter broke over lines", () => {
    const source = [
      "function textOf(err: unknown): string {",
      "  return maskSecrets(",
      "    err instanceof Error",
      "      ? err.message",
      "      : String(err),",
      "  );",
      "}",
    ].join("\n");
    expect(definesBody(source, ERROR_TEXT_SHAPE)).toBe(true);
  });

  test("finds a record check that the formatter wrapped in parentheses", () => {
    const source = [
      "function isObject(value: unknown): value is Record<string, unknown> {",
      "  return (",
      '    typeof value === "object" &&',
      "    value !== null &&",
      "    !Array.isArray(value)",
      "  );",
      "}",
    ].join("\n");
    expect(definesBody(source, RECORD_SHAPE)).toBe(true);
  });

  test("finds an arrow function that checks for a record", () => {
    const source = [
      "const isObject = (value: unknown): value is Record<string, unknown> =>",
      '  typeof value === "object" && value !== null && !Array.isArray(value);',
    ].join("\n");
    expect(definesBody(source, RECORD_SHAPE)).toBe(true);
  });

  test("does not find a function that does more than the error text", () => {
    const source = [
      "function textOf(err: unknown): string {",
      "  return clean(err instanceof Error ? err.message : String(err));",
      "}",
    ].join("\n");
    expect(definesBody(source, ERROR_TEXT_SHAPE)).toBe(false);
  });
});

describe("isRecord", () => {
  test("is defined only in types.ts and the files that cannot import it", () => {
    expect(definedOutside("isRecord", IS_RECORD_HOMES)).toEqual([]);
  });

  test("has its body under any name only in the files of the table", () => {
    expect(filesWithRecordBody()).toEqual(Object.keys(IS_RECORD_HOMES).sort());
  });
});

describe("errorMessage", () => {
  test("is defined only in log.ts and the files that cannot import it", () => {
    expect(definedOutside("errorMessage", ERROR_TEXT_HOMES)).toEqual([]);
  });

  test("has its body under any name only in the files of the table", () => {
    expect(filesWithErrorTextBody()).toEqual(
      Object.keys(ERROR_TEXT_HOMES).sort(),
    );
  });
});

describe("JST_OFFSET_MS", () => {
  test("is defined only in jst.ts and the files that cannot import it", () => {
    expect(filesDefining("JST_OFFSET_MS")).toEqual(
      Object.keys(JST_OFFSET_HOMES).sort(),
    );
  });
});

describe("the text for a time that is not a time", () => {
  test("is written in f/ only by jst.ts", () => {
    expect(
      trackedTypeScriptFiles().filter(
        (path) =>
          path.startsWith("f/") && /"NaN(?:-NaN-NaN|:NaN)/.test(read(path)),
      ),
    ).toEqual(["f/factory/lib/jst.ts"]);
  });
});

describe("the shared leaf modules", () => {
  test.each([
    "f/factory/lib/types.ts",
    "f/factory/lib/log.ts",
    "f/factory/lib/jst.ts",
  ])("%s imports nothing", (path) => {
    expect(read(path)).not.toMatch(/^\s*(?:import|export)\b[^;]*\bfrom\s+"/m);
  });
});
