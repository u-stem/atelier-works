import { describe, expect, test } from "bun:test";

// `self_update.ts`の、`deployed_sha`を更新する前後の順序を、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、反映が済んだ後の失敗が、失敗の記録として残ることを防ぐ変更に気づくことである。

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

describe("self_update deployed sha update order", () => {
  test("lists the changed paths before updating the deployed sha", async () => {
    const source = await selfUpdateSource();

    expect(at(source, "await resolveChangedPaths(")).toBeLessThan(
      at(source, "await setDeployedSha("),
    );
  });

  test("compares the mise.toml sections before updating the deployed sha", async () => {
    const source = await selfUpdateSource();

    expect(at(source, "await miseTomlHostSectionsChanged(")).toBeLessThan(
      at(source, "await setDeployedSha("),
    );
  });

  test("remembers that the deployed sha was updated right after the update", async () => {
    const source = await selfUpdateSource();

    expect(at(source, "deployedShaUpdated = true")).toBeGreaterThan(
      at(source, "await setDeployedSha("),
    );
  });

  test("remembers the update before recording the deployment", async () => {
    const source = await selfUpdateSource();

    expect(at(source, "deployedShaUpdated = true")).toBeLessThan(
      at(source, "await recordSuccessDeployment("),
    );
  });

  test("does not record a failed deployment once the deployed sha is updated", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /if \(!reconcileOnly && !deployedShaUpdated\) \{\s*await recordFailedDeployment\(/,
    );
  });

  test("still returns held before any wmill call", async () => {
    const source = await selfUpdateSource();

    expect(at(source, 'return { outcome: "held"')).toBeLessThan(
      at(source, "await runWmillCli("),
    );
  });
});
