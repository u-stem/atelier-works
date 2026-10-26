// implement_verifyのmainは、Windmillの変数・リソースとDBを直接使うので、
// 承認済みの要件定義の照合の結線と、最初のラウンドの種類による分岐はソースの文面で固定する。
// 照合そのものの振る舞いは`tests/lib/implement_loop.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

async function source(): Promise<string> {
  return Bun.file(
    new URL("../../f/factory/steps/implement_verify.ts", import.meta.url),
  ).text();
}

/** `needle`の出現回数。 */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the requirements check around the copy in implement_verify", () => {
  test("runs each fix round through the guarded round with the baseline of the context", async () => {
    expect(await source()).toMatch(
      /runDocDirGuardedRound\(\s*context\.requirements_doc_dir,\s*docDirGuardFor\(context/,
    );
  });

  test("hands the guarded copy to the Claude round", async () => {
    expect(await source()).toMatch(/\(docDir\) =>\s*runImplementClaudeRound\(/);
  });

  test("does not copy the directory without the check", async () => {
    expect(await source()).not.toContain("withReadOnlyDocDirCopy");
  });
});

describe("the first round that never reaches the checks in implement_verify", () => {
  test("decides the deadline check and the notice from the same test", async () => {
    expect(count(await source(), "ranClaude(first_round)")).toBe(2);
  });

  test("does not decide from the lease alone", async () => {
    expect(await source()).not.toContain('first_round.kind === "lease_lost"');
  });

  test("does not add the notice from the lease alone", async () => {
    expect(await source()).not.toContain('first_round.kind !== "lease_lost"');
  });
});
