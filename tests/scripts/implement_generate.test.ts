// implement_generateのmainは、Windmillの変数・リソースとDBを直接使うので、
// 承認済みの要件定義の照合の結線はソースの文面で固定する。
// 照合そのものの振る舞いは`tests/lib/implement_loop.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

async function source(): Promise<string> {
  return Bun.file(
    new URL("../../f/factory/steps/implement_generate.ts", import.meta.url),
  ).text();
}

describe("the requirements check around the copy in implement_generate", () => {
  test("runs Claude through the guarded round with the baseline of the context", async () => {
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
