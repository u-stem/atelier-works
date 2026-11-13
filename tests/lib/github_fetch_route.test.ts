// `tests/preload.ts`が置き換えたグローバルの`fetch`のテスト。
// GitHubのAPIとその取得先への要求は、偽の応答の関数が無ければ例外で拒み、本物へは送らない。

import { describe, expect, test } from "bun:test";
import { createFakeCommandRunner, ghApiOk } from "./testSupport.ts";

async function rejectionOf(url: string): Promise<string> {
  const error = await fetch(url).catch((err: unknown) => err);
  return error instanceof Error ? error.message : "resolved";
}

describe("the fetch of the tests", () => {
  test("refuses the GitHub API when no fake answers", async () => {
    expect(await rejectionOf("https://api.github.com/zen")).toContain(
      "tests must not reach GitHub",
    );
  });

  test("refuses the blob storage when no fake answers", async () => {
    expect(
      await rejectionOf("https://acct.blob.core.windows.net/logs/1.txt"),
    ).toContain("tests must not reach GitHub");
  });

  test("lets a fake runner answer the GitHub API", async () => {
    createFakeCommandRunner([ghApiOk({ ok: true })]);
    const response = await fetch("https://api.github.com/repos/o/r");
    expect(await response.json()).toEqual({ ok: true });
  });

  // 前のテストが作った偽のrunnerは、テストが終わると外れる。
  test("forgets the fake runner of the previous test", async () => {
    expect(await rejectionOf("https://api.github.com/repos/o/r")).toContain(
      "tests must not reach GitHub",
    );
  });
});
