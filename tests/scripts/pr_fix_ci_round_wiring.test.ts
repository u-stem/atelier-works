// CI回の配線の構造のテスト。
// 各ステップのmainはWindmillとDBを直接使うので、配線はソースの並びで確かめる。
// 部品そのものの判定は`tests/lib/ci_fix_round.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import {
  CI_FIX_ALLOWED_TOOLS,
  CI_FIX_TOOLS,
} from "../../f/factory/lib/ci_fix_round.ts";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

/** `needle`の出現回数。 */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the tools of Claude in a CI round", () => {
  test("does not offer Bash in the set of usable tools", () => {
    expect(CI_FIX_TOOLS).not.toContain("Bash");
  });

  test("does not allow Bash without a prompt", () => {
    expect(CI_FIX_ALLOWED_TOOLS).not.toContain("Bash");
  });

  test("allows only tools that are also usable", () => {
    expect(
      CI_FIX_ALLOWED_TOOLS.every((tool) => CI_FIX_TOOLS.includes(tool)),
    ).toBe(true);
  });

  test("is used by the fix step", async () => {
    const text = await source("pr_fix_apply.ts");
    expect([
      count(text, "tools: CI_FIX_TOOLS,"),
      count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,"),
    ]).toEqual([1, 1]);
  });

  test("is used by the retry in the verify step", async () => {
    const text = await source("pr_fix_verify.ts");
    expect([
      count(text, "tools: CI_FIX_TOOLS,"),
      count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,"),
    ]).toEqual([1, 1]);
  });
});

describe("the finish step of a CI round", () => {
  test("records the head of the work item only in the bookkeeping that a CI round skips", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.includes(
        "await runPostPushBookkeeping(ciRound, {\n    postReplies: () => postFixReplies(newSha),\n    setHeadSha: () => setHeadSha(work_item_id, newSha),",
      ),
    ).toBe(true);
  });

  test("calls setHeadSha nowhere else", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "setHeadSha(")).toBe(1);
  });

  test("posts the replies of the nothing-to-commit path only outside a CI round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "if (!ciRound) await postFixReplies(null);")).toBe(1);
  });
});
