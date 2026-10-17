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
  test("does not resolve notices before the deployment decision", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("decideUpdate(currentSha") <
        source.indexOf("await resolveHostActionNotices()"),
    ).toBe(true);
  });

  test("resolves notices before the unchanged return", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await resolveHostActionNotices()") <
        source.indexOf('return { outcome: "unchanged" }'),
    ).toBe(true);
  });

  test("resolves notices after raising the notice on a deployed run", async () => {
    const source = await selfUpdateSource();

    expect(
      source.indexOf("await recordHostAction(") <
        source.lastIndexOf("await resolveHostActionNotices()"),
    ).toBe(true);
  });

  test("resolves notices once on each path", async () => {
    const source = await selfUpdateSource();

    expect(source.match(/await resolveHostActionNotices\(\)/g)?.length).toBe(3);
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

  test("starts the automatic retry after resolving notices", async () => {
    const source = await selfUpdateSource();

    const reconcile = source.indexOf("await reconcileHostActionNotices(");
    const start = source.indexOf("await startStaleImageRetry(log)");

    expect([reconcile >= 0, start >= 0, reconcile < start]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("starts the automatic retry only through the start decision", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /if \(\s*await shouldStartStaleImageRetry\(\{[\s\S]*?\}\)\s*\) \{\s*await startStaleImageRetry\(log\);\s*\}\s*return resolved;/,
    );
  });

  test("passes the resolved count to the start decision", async () => {
    const source = await selfUpdateSource();

    expect(source).toContain("resolvedCount: resolved,");
  });

  test("selects the retry candidates with the same query as the retry script", async () => {
    const source = await selfUpdateSource();

    expect(source).toContain("autoRetryCandidateQuery(AUTO_RETRY_LIST_LIMIT)");
  });

  test("starts the automatic retry script by its path", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /runScriptByPathAsync\(\s*"f\/factory\/auto_retry_stale_image",/,
    );
  });

  test("compares the host content in the self clone", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /differingPaths: \(from, to\) =>\s*listDifferingPaths\(runCommand, factoryClone\.dir, from, to\),/,
    );
  });

  test("reads the current HEAD from the self clone", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /const currentSha = await readSelfCloneHeadSha\(\s*runCommand,\s*factoryClone\.dir,?\s*\);/,
    );
  });
});
