import { describe, expect, test } from "bun:test";

// `self_update.ts`への組み込みの順序と引数を、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、通知の解決を反映の要否の判定より後ろへ動かしたり、
// 記録より前に通知を出したり、通知に別の版を渡したりする変更に気づくことである。

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("self_update host action wiring", () => {
  test("resolves notices before deciding whether to deploy", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await reconcileHostActionNotices(") <
        source.indexOf("decideUpdate(currentSha"),
    ).toBe(true);
  });

  test("resolves notices before the unchanged return", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await reconcileHostActionNotices(") <
        source.indexOf('return { outcome: "unchanged" }'),
    ).toBe(true);
  });

  test("records the deployment before raising the notice", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await recordSuccessDeployment(") <
        source.indexOf("await recordHostAction("),
    ).toBe(true);
  });

  test("raises the notice only when the deployment needs host action", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /if \(classification\.needs_host_action\) \{[\s\S]*?await recordHostAction\(/,
    );
  });

  test("passes the self clone HEAD and the host paths to the notice", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /await recordHostAction\([\s\S]*?\},\s*currentSha,\s*classification\.host_paths,\s*\);/,
    );
  });

  test("shares one applied checker between resolving and raising", async () => {
    const source = await selfUpdateSource();

    expect(source.match(/isApplied: hostApplied,/g)?.length).toBe(2);
  });

  test("reads the current HEAD from the self clone", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /const currentSha = await readSelfCloneHeadSha\(\s*runCommand,\s*factoryClone\.dir,?\s*\);/,
    );
  });
});
