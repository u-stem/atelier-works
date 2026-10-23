// CI回の基点の配線のテスト。
// 各ステップのmainはWindmillとDBを直接使うので、配線はソースの並びで確かめる。
// ソースの文字列と完全に一致するかを見るテストは、整形や変数名の変更で落ちる。落ちたときは、配線が変わったかを確かめて、文字列を直す。
// 結合の誤りを捕まえるのは、呼び出しの前後関係を見るテスト(`indexOf`で順序を比べるもの)である。
// 基点を求める部品と、それを使う判定そのものは、`tests/lib/ci_fix_pr_base.test.ts`と`ci_fix_round_*.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

describe("the apply step of a CI round", () => {
  async function ciRoundSource(): Promise<string> {
    const text = await source("pr_fix_apply.ts");
    return text.slice(text.indexOf("async function applyCiRound("));
  }

  test("checks that the base can be resolved before it builds the system prompt", async () => {
    const text = await ciRoundSource();
    expect(text.indexOf("resolvePrMergeBase(")).toBeLessThan(
      text.indexOf("buildSystemPrompt("),
    );
  });

  test("checks that the base can be resolved before it runs Claude", async () => {
    const text = await ciRoundSource();
    expect(text.indexOf("resolvePrMergeBase(")).toBeLessThan(
      text.indexOf("runClaude("),
    );
  });

  test("checks the git pointer before it fetches the base", async () => {
    const text = await ciRoundSource();
    expect(text).toContain(
      "assertWorktreeIntact: () =>\n            assertWorktreeGitPointer(input.worktreeDir, input.recordedPointer)",
    );
  });
});

describe("the steps that read the changes of a CI round", () => {
  test("passes the resolver of the base in the verify step", async () => {
    expect(await source("pr_fix_verify.ts")).toContain(
      "resolvePrBase: resolvePrBaseOnce",
    );
  });

  test("passes the resolver of the base in the finish step", async () => {
    expect(await source("pr_fix_finish.ts")).toContain(
      "resolvePrBase: resolvePrBaseOnce",
    );
  });

  test("checks the git pointer before it fetches the base in the verify step", async () => {
    expect(await source("pr_fix_verify.ts")).toContain(
      "assertWorktreeIntact: async () => {",
    );
  });

  test("checks the git pointer before it fetches the base in the finish step", async () => {
    expect(await source("pr_fix_finish.ts")).toContain(
      "assertWorktreeIntact: async () => {",
    );
  });

  test("does not resolve the base for the read that decides whether a change is a recomputed lock", async () => {
    const text = await source("pr_fix_finish.ts");
    const start = text.indexOf("const collected = await collectCiFixChanges(");
    const call = text.slice(start, text.indexOf(");", start));
    expect(call).not.toContain("resolvePrBase");
  });
});
