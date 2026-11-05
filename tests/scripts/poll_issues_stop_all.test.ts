import { describe, expect, test } from "bun:test";

// Issueの取り込みの全停止の関門を、`poll_issues.ts`のソースの文字列照合で確かめる。
// 関門の判定そのもの(`unlessStopped`)は`tests/lib/stop_all.test.ts`が確かめる。

async function source(): Promise<string> {
  return Bun.file("f/factory/poll_issues.ts").text();
}

describe("poll_issues stop-all gate", () => {
  test("decides the issue actions only through unlessStopped", async () => {
    const text = await source();

    expect(text).toMatch(
      /unlessStopped\(\s*stop,\s*\(\)\s*=>\s*decideIssueActions\(/,
    );
  });

  test("calls decideIssueActions at one place", async () => {
    const text = await source();

    expect(text.match(/\bdecideIssueActions\(/g)?.length).toBe(1);
  });

  test("reads the stop-all through the shared reader", async () => {
    const text = await source();

    expect(text).toContain("await readStopAll(sdkStopAllReadIo())");
  });

  test("reads the stop-all after the candidates are built", async () => {
    const text = await source();

    expect(text.indexOf("await buildIssueCandidates(")).toBeLessThan(
      text.indexOf("await readStopAll(sdkStopAllReadIo())"),
    );
  });
});
