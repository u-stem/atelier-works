// `tests/preload.ts`が置き換えたグローバルの`fetch`のテスト。
// GitHubのAPIとその取得先への要求は、偽の応答の関数が無ければ例外で拒み、本物へは送らない。

import { describe, expect, test } from "bun:test";
import { getDefaultBranch } from "../../f/factory/lib/github.ts";
import { GitHubHttpError } from "../../f/factory/lib/github_errors.ts";
import { GITHUB_FETCH_EXHAUSTED_KEY } from "../preload.ts";
import { createFakeCommandRunner, ghApiOk } from "./testSupport.ts";

async function rejectionOf(url: string): Promise<string> {
  const error = await fetch(url).catch((err: unknown) => err);
  return error instanceof Error ? error.message : "resolved";
}

/** 呼べば例外を投げる`run`だけを持つ依頼の手段。依存の組み立てのテストが渡すものと同じ形にする。 */
const RUN_THROWS_CLIENT = {
  run: async (): Promise<never> => {
    throw new Error("the builder must not call GitHub");
  },
  ghToken: "token",
  sleep: async (): Promise<void> => {},
};

/** 失敗したGETの、応答のステータス。失敗しなければ`null`。 */
async function failedStatusOf(
  promise: Promise<unknown>,
): Promise<number | null> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  return error instanceof GitHubHttpError ? error.status : null;
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

  // `run`が例外を投げる依頼の手段でも、GETは`fetch`で送られ、偽の応答が無ければ拒まれて失敗する。
  // 依存の組み立てのテストは、これでGETも「GitHubを呼ばない」ことを確かめる。
  // 本物へ届けば偽のトークンは401になるので、ステータス0は本物へ送っていないことも示す。
  test("fails a GET of a client whose run throws when no fake answers", async () => {
    expect(
      await failedStatusOf(getDefaultBranch(RUN_THROWS_CLIENT, "o", "r")),
    ).toBe(0);
  });

  // 用意した応答より多い要求は、通信の失敗として静かに飲み込まれないよう記録し、テストの後で失敗にする。
  test("records a request after the fake answers ran out", async () => {
    createFakeCommandRunner([]);
    await fetch("https://api.github.com/repos/o/r").catch(() => undefined);
    const recorded: unknown = Reflect.get(
      globalThis,
      GITHUB_FETCH_EXHAUSTED_KEY,
    );
    // このテストでは記録を確かめるだけなので、テストの後の失敗にしないよう消す。
    Reflect.deleteProperty(globalThis, GITHUB_FETCH_EXHAUSTED_KEY);
    expect(typeof recorded).toBe("string");
  });

  // 前のテストが作った偽のrunnerは、テストが終わると外れる。
  test("forgets the fake runner of the previous test", async () => {
    expect(await rejectionOf("https://api.github.com/repos/o/r")).toContain(
      "tests must not reach GitHub",
    );
  });
});
