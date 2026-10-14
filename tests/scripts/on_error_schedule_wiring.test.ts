import { describe, expect, test } from "bun:test";

// `on_error_schedule.ts`の配線の順序と引数を、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、前回の失敗の記録を今回の記録より後に読む変更や、
// 履歴を二重に取得する変更、続けて失敗している通知をDiscordに送り直さない変更に気づくことである。

/** コメントを除いた`on_error_schedule.ts`のソース。 */
async function handlerSource(): Promise<string> {
  const text = await Bun.file("f/factory/on_error_schedule.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("on_error_schedule wiring", () => {
  test("reads the previous failure before recording this one", async () => {
    const source = await handlerSource();

    expect(
      source.indexOf("await getLatestScheduleFailure(") <
        source.indexOf("await recordFailure("),
    ).toBe(true);
  });

  test("fetches the job history from one place", async () => {
    const source = await handlerSource();

    expect(source.match(/JobService\.listCompletedJobs\(/g)?.length).toBe(1);
  });

  test("shares the history request with the failing schedule check", async () => {
    const source = await handlerSource();

    expect(source).toContain("listRecentRuns: () => fetchRuns(),");
  });

  test("decides the notification from the previous failure and the history", async () => {
    const source = await handlerSource();

    expect(source).toMatch(
      /shouldNotifyJobFailed\(\{\s*runs,\s*jobId: resolvedJobId,\s*previousFailure,\s*currentError: message,\s*\}\)/,
    );
  });

  test("announces to Discord when the failing notice is inserted", async () => {
    const source = await handlerSource();

    expect(source).toContain("onFailingNoticeInserted: sendJobFailed,");
  });

  test("does not read the history for an unknown schedule", async () => {
    const source = await handlerSource();

    expect(source).toMatch(
      /flowPath !== "unknown"\) \{\s*try \{\s*runs = await fetchRuns\(\);/,
    );
  });
});
