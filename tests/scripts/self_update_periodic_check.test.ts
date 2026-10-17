import { describe, expect, test } from "bun:test";

// `self_update`は、更新の成否によらず、定期ジョブ用のworkerがtag `periodic`のジョブを受けているかを確かめる。
// 確かめる処理が止まっても更新を遅らせないよう、確認の上限を最悪の長さに数える。
// どちらも`self_update.ts`のソースの文字列照合で、構文は解析しない。

async function selfUpdateSource(): Promise<string> {
  return Bun.file("f/factory/self_update.ts").text();
}

/** `finally`の節。更新が例外を投げても確認が走ることを確かめるために切り出す。 */
function finallyBlock(source: string): string {
  const start = source.indexOf("} finally {");
  return start < 0 ? "" : source.slice(start);
}

describe("self_update periodic worker check", () => {
  test("runs the check in the finally block", async () => {
    expect(finallyBlock(await selfUpdateSource())).toContain(
      "checkPeriodicWorker(",
    );
  });

  test("lists the waiting jobs with the periodic query", async () => {
    expect(await selfUpdateSource()).toContain(
      "periodicQueueQuery(wmillDefault.getWorkspace())",
    );
  });

  test("counts the check timeout in the worst case", async () => {
    const source = await selfUpdateSource();
    const start = source.indexOf("export const SELF_UPDATE_WORST_CASE_MS");
    expect(source.slice(start, source.indexOf(";", start))).toContain(
      "PERIODIC_WORKER_CHECK_TIMEOUT_MS",
    );
  });

  test("resolves the notice as self_update", async () => {
    expect(await selfUpdateSource()).toContain(
      "resolveUnresolvedNoticesByPrefix(",
    );
  });
});
