// `runClaude`を呼ぶすべてのファイルが、モデルを`modelFor`系の関数で選ぶことを確かめる。
// 構文を解析せず、ソースの文字列を照合する。したがって、別名やスプレッドで
// `config.model`を渡す書き方は見つけられない。
// 新しい呼び出しが`model: config.model`を直接渡す書き方を持ち込んだときに気づくための検査である。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const DEFINITION_FILE = "lib/claude.ts";
// `runClaude(`と`runClaude<T>(`の呼び出し。
const RUN_CLAUDE_CALL = /\brunClaude\s*(<[^>(]*>)?\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => path.endsWith(".ts") && !path.includes("node_modules"));
}

const CLAUDE_CALLERS = sourceFiles(FACTORY_DIR)
  .map((path) => ({
    path: relative(FACTORY_DIR, path),
    text: readFileSync(path, "utf8"),
  }))
  .filter(
    ({ path, text }) => path !== DEFINITION_FILE && RUN_CLAUDE_CALL.test(text),
  );

describe("model assignment", () => {
  test("finds the files that call runClaude", () => {
    expect(CLAUDE_CALLERS.length).toBeGreaterThanOrEqual(6);
  });

  test("no caller passes config.model to the model option directly", () => {
    const direct = CLAUDE_CALLERS.filter(({ text }) =>
      /model:\s*(input\.)?config\.model\b/.test(text),
    ).map(({ path }) => path);
    expect(direct).toEqual([]);
  });

  test("every caller selects the model with modelFor or prFixRetryModel", () => {
    const missing = CLAUDE_CALLERS.filter(
      ({ text }) => !/\b(modelFor|prFixRetryModel)\(/.test(text),
    ).map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  // 失敗の数を数える関数の結果を、モデルの選択に渡す配線を守る。
  // 数えた値を変数に入れ、その変数を渡す形を、ソースの文字列で照合する。
  describe("failure count wiring", () => {
    const wiring: [string, string, RegExp][] = [
      [
        "steps/pr_fix_apply.ts",
        "countPrFixFailures(",
        /const sonnetFailures = await countPrFixFailures\(\w+\);[\s\S]*modelFor\(config, "pr_fix", sonnetFailures\)/,
      ],
      [
        "steps/pr_fix_verify.ts",
        "countPrFixFailures(",
        /const sonnetFailures = await countPrFixFailures\(\w+\);[\s\S]*prFixRetryModel\(config, sonnetFailures\)/,
      ],
      [
        "steps/implement_generate.ts",
        "countImplementFailedRounds(",
        /const sonnetFailures = await countImplementFailedRounds\([\s\S]*?\);[\s\S]*attempt: context\.attempt,\s*sonnetFailures,/,
      ],
      [
        "steps/implement_verify.ts",
        "countImplementFailedRounds(",
        /const sonnetFailures = await countImplementFailedRounds\([\s\S]*?\);[\s\S]*attempt: context\.attempt,\s*sonnetFailures,/,
      ],
      [
        "steps/implement_verify.ts",
        "modelChangesAfterFailure(",
        /modelChangesAfterFailure\(\s*config,\s*"implement",\s*await countImplementFailedRounds\(work_item_id, context\.attempt\),?\s*\)/,
      ],
    ];

    test.each(wiring)("%s calls %s", (path, call) => {
      expect(readFileSync(join(FACTORY_DIR, path), "utf8")).toContain(call);
    });

    test.each(wiring)(
      "%s passes the counted value on (%s)",
      (path, _call, pattern) => {
        expect(readFileSync(join(FACTORY_DIR, path), "utf8")).toMatch(pattern);
      },
    );
  });
});
