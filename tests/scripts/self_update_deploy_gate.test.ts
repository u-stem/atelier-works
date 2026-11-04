import { describe, expect, test } from "bun:test";

// 保護パスの変更の判定の、`self_update.ts`への組み込みの位置と引数を、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。
// 目的は、判定をpushの後ろへ動かしたり、失敗の行を足す処理の中へ入れたり、別の版や範囲を渡したりする変更に気づくことである。

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

/** 見つからない照合を、通ったことにしないために例外にする。 */
function at(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`not found in self_update.ts: ${needle}`);
  return index;
}

describe("self_update deploy approval gate", () => {
  test("decides after the deploy freeze hold", async () => {
    const text = await selfUpdateSource();
    expect(at(text, "shouldHoldDeploy(freeze.value)")).toBeLessThan(
      at(text, "await runDeployApprovalGate("),
    );
  });

  test("decides before the wmill token is read", async () => {
    const text = await selfUpdateSource();
    expect(at(text, "await runDeployApprovalGate(")).toBeLessThan(
      at(text, 'getVariable("f/factory/wmill_token")'),
    );
  });

  test("decides before the first wmill call", async () => {
    const text = await selfUpdateSource();
    expect(at(text, "await runDeployApprovalGate(")).toBeLessThan(
      at(text, "await runWmillCli("),
    );
  });

  test("decides outside the try block that records a failed deployment", async () => {
    const text = await selfUpdateSource();
    expect(at(text, "await runDeployApprovalGate(")).toBeLessThan(
      at(text, "let deployedShaUpdated"),
    );
  });

  test("decides only on a run that deploys after a previous deployment", async () => {
    expect(await selfUpdateSource()).toMatch(
      /if \(!reconcileOnly && deployedSha\.length > 0\) \{\s*const gate = await runDeployApprovalGate\(currentSha,/,
    );
  });

  test("lists the changes between the deployed sha and HEAD", async () => {
    expect(await selfUpdateSource()).toMatch(
      /listChangedEntries\(\s*runCommand,\s*factoryClone\.dir,\s*deployedSha,\s*currentSha,?\s*\)/,
    );
  });

  test("returns held with the approval reason when the gate holds", async () => {
    expect(await selfUpdateSource()).toMatch(
      /if \(gate\.kind === "hold"\) \{[\s\S]*?return \{ outcome: "held", reason: "protected_paths_approval" \};/,
    );
  });

  test("returns held before the deployed sha update", async () => {
    const text = await selfUpdateSource();
    expect(at(text, 'reason: "protected_paths_approval"')).toBeLessThan(
      at(text, "setDeployedSha("),
    );
  });

  test("resolves the approval notices after recording a successful deployment", async () => {
    const text = await selfUpdateSource();
    expect(at(text, "await recordSuccessDeployment(")).toBeLessThan(
      at(text, '"resolve deploy approval notices"'),
    );
  });

  test("decides only once", async () => {
    expect(
      (await selfUpdateSource()).match(/runDeployApprovalGate\(/g)?.length,
    ).toBe(1);
  });
});
