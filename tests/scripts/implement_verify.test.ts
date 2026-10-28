// implement_verifyのmainは、Windmillの変数・リソースとDBを直接使うので、
// 承認済みの要件定義の照合の結線と、最初のラウンドの種類による分岐はソースの文面で固定する。
// 照合そのものの振る舞いは`tests/lib/implement_loop.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

/** コメントを除いたソース。コメントに書いた呼び出しの名前や条件を、結線として数えないため。 */
async function source(): Promise<string> {
  const text = await Bun.file(
    new URL("../../f/factory/steps/implement_verify.ts", import.meta.url),
  ).text();
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

  test("calls the guarded round exactly once", async () => {
    expect(count(await source(), "runDocDirGuardedRound(")).toBe(1);
  });

  test("calls the Claude round exactly once, inside the guarded round", async () => {
    expect(count(await source(), "runImplementClaudeRound(")).toBe(1);
  });
});

describe("the first round that never reaches the checks in implement_verify", () => {
  test("checks the deadline only when the first round ran Claude", async () => {
    expect(await source()).toMatch(
      /const deadlineAt = ranClaude\(first_round\)\s*\?\s*requireDeadlineAt\(/,
    );
  });

  test("adds the notice of the checks only when the first round ran Claude", async () => {
    expect(await source()).toMatch(
      /commands\.length > 0 && ranClaude\(first_round\)\)/,
    );
  });

  test("does not decide from the lease alone", async () => {
    expect(await source()).not.toContain('first_round.kind === "lease_lost"');
  });

  test("does not add the notice from the lease alone", async () => {
    expect(await source()).not.toContain('first_round.kind !== "lease_lost"');
  });
});

describe("the design flag of the fix rounds in implement_verify", () => {
  test("passes whether the context carries a design to the Claude round", async () => {
    expect(await source()).toContain(
      "hasDesign: implementContextHasDesign(context)",
    );
  });

  test("selects the output contract note by the same flag", async () => {
    expect(await source()).toContain(
      "outputContractNote: implementOutputContractNote(",
    );
  });
});
