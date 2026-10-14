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
      expect(source(name)).toContain("checkSandboxFromEnv(process.env,");
    });

    test(`${name} records the check slot notices unless one is unresolved`, () => {
      expect(source(name)).toMatch(
        /checkSandboxFromEnv\(process\.env, async \(notice\) => \{\s*await addNoticeUnlessUnresolved\(notice\);/,
      );
    });
  }
});

// 実装とPR修正の準備のステップが、worktreeを用意する前に、workerが検査を実行できるかを確かめることを確かめる。
// 関門を外すか後ろへ動かす変更は、Claudeの1回分を使ってから検証のステップで止まるので、ここで落とす。
const FLOWS_DIR = join(import.meta.dir, "../../f/factory");

function flowSource(name: string): string {
  return readFileSync(join(FLOWS_DIR, name, "flow.yaml"), "utf8");
}

/** 両方が見つかり、`first`が`second`より前にあるかを返す。 */
function inOrder(first: number, second: number): boolean {
  return first >= 0 && second >= 0 && first < second;
}

const GATES = [
  {
    step: "implement_prepare.ts",
    hasCheckCommands: /checkImageGate\(\s*checkCommands\.length > 0,/,
    worktree: "prepareImplementWorktree(",
    flow: "implement__flow",
    claudeStep: "f/factory/steps/implement_generate",
  },
  {
    step: "pr_fix_prepare.ts",
    hasCheckCommands:
      /checkImageGate\(\s*config\.allowed_check_commands\.length > 0,/,
    worktree: "createGtrWorktree(",
    flow: "pr_fix__flow",
    claudeStep: "f/factory/steps/pr_fix_apply",
  },
] as const;

describe("check image gate wiring", () => {
  for (const gate of GATES) {
    test(`${gate.step} calls checkImageGate`, () => {
      expect(source(gate.step)).toContain("checkImageGate(");
    });

    test(`${gate.step} gates only when the repository has check commands`, () => {
      expect(source(gate.step)).toMatch(gate.hasCheckCommands);
    });

    test(`${gate.step} gates before it prepares the worktree`, () => {
      const text = source(gate.step);
      expect(
        inOrder(text.indexOf("checkImageGate("), text.indexOf(gate.worktree)),
      ).toBe(true);
    });

    test(`${gate.step} does not start Claude itself`, () => {
      expect(source(gate.step)).not.toMatch(/\brunClaude\b|\binvokeClaude\b/);
    });

    test(`${gate.flow} runs ${gate.step} before the step that starts Claude`, () => {
      const text = flowSource(gate.flow);
      const prepare = `f/factory/steps/${gate.step.replace(/\.ts$/, "")}`;
      expect(
        inOrder(
          text.indexOf(`path: ${prepare}\n`),
          text.indexOf(`path: ${gate.claudeStep}\n`),
        ),
      ).toBe(true);
    });
  }
});
