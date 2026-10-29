import { describe, expect, test } from "bun:test";

// `self_update.ts`が、自動再開の起動の要否を決める判定を、`auto_retry_stale_image.ts`と同じ共有の判定につないでいることを、
// ソースの文字列照合で固定する。2つの判定が食い違うと、再開しない作業項目のために起動するか、再開する作業項目を取りこぼす。
// 構文は解析しないので、書き方を変えると実装が正しくても落ちる。そのときは照合を直す。

/** コメントを除いたscriptのソース。 */
async function scriptSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("self_update wiring of the auto retry check", () => {
  test("decides whether a candidate can restart with the shared check", async () => {
    const source = await scriptSource();

    expect(source).toContain("isReadyForImplement(");
  });

  test("tells the shared check whether the design is enabled", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /isReadyForImplement\(\s*candidate,\s*config\.design_enabled,/,
    );
  });

  test("gives the shared check the readers of both approvals", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /isReadyForImplement\([\s\S]*?\{\s*latestRequirementsApproval,\s*latestDesignApproval,?\s*\}/,
    );
  });

  test("does not judge the requirements approval by itself", async () => {
    const source = await scriptSource();

    expect(source).not.toContain("isRequirementsApprovedForAttempt(");
  });

  test("asks the shared check inside the bounded check of the candidates", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /withCallTimeout\("check auto retry candidates",[\s\S]*?isReadyForImplement\(/,
    );
  });

  test("gives the check of the candidates the reader of the unfinished runs", async () => {
    const source = await scriptSource();

    expect(source).toMatch(
      /withCallTimeout\("check auto retry candidates",[\s\S]*?hasUnfinishedPrRun,/,
    );
  });
});
