import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 検査コマンドを実行する2つのステップが、検査用の非特権uidの部品を渡すことを確かめる。
// `runAllowedCheckCommands`は部品が無いとworkerのuidのまま実行するので、
// 渡し忘れる変更を、ここで落とす。
const STEPS_DIR = join(import.meta.dir, "../../f/factory/steps");

function source(name: string): string {
  return readFileSync(join(STEPS_DIR, name), "utf8");
}

/** `runAllowedCheckCommands(`から、対応する閉じ括弧までの呼び出し全体を返す。 */
function checkCall(text: string): string {
  const start = text.indexOf("runAllowedCheckCommands(");
  if (start < 0) return "";
  let depth = 0;
  for (let index = text.indexOf("(", start); index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return "";
}

describe("check sandbox wiring", () => {
  for (const name of ["implement_verify.ts", "pr_fix_verify.ts"]) {
    test(`${name} passes the check sandbox to runAllowedCheckCommands`, () => {
      expect(checkCall(source(name))).toMatch(/,\s*checkSandbox,?\s*\)$/);
    });

    test(`${name} builds the check sandbox from the environment`, () => {
      expect(source(name)).toContain("checkSandboxFromEnv()");
    });
  }
});
