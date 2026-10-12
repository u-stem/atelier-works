import { describe, expect, test } from "bun:test";

// `self_update.ts`への`factory_repo_id`の照合の組み込みを、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、照合を取得より後ろへ動かしたり、
// 照合に落ちた回が取得や反映へ進んだりする変更に気づくことである。

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("self_update factory repo id wiring", () => {
  test("checks the repository id before fetching the self clone", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await gateFactoryRepoId(") <
        source.indexOf("await ensureFactoryClone("),
    ).toBe(true);
  });

  test("returns before fetching the self clone when the check fails", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /await gateFactoryRepoId\([\s\S]*?\);\s*if \(!factoryRepoVerified\) \{[\s\S]*?return \{ outcome: "skipped"[^}]*\};\s*\}\s*const factoryClone = await ensureFactoryClone\(/,
    );
  });

  test("passes the configuration to the check", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(/await gateFactoryRepoId\(\s*config,/);
  });
});
