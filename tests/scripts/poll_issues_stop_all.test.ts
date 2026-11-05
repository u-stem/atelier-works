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

    expect(text).toContain("readStopAll(sdkStopAllReadIo())");
  });

  test("reads the stop-all after the candidates are built", async () => {
    const text = await source();

    expect(text.indexOf("await buildIssueCandidates(")).toBeLessThan(
      text.indexOf("const stop = await readStopAllBounded()"),
    );
  });

  test("bounds the read of the stop-all with its own timeout", async () => {
    const text = await source();

    expect(text).toMatch(
      /withCallTimeout\(\s*"read stop-all",[\s\S]{0,120}STOP_ALL_CHECK_TIMEOUT_MS,\s*\)/,
    );
  });

  test("treats a timed-out read of the stop-all as unreadable", async () => {
    const text = await source();

    expect(text).toMatch(
      /\.catch\(\s*\(\): StopAllStatus => \(\{\s*kind: "unreadable"/,
    );
  });

  test("reads the stop-all through the bounded reader in one place of main", async () => {
    const text = await source();

    expect(text.match(/await readStopAllBounded\(\)/g)?.length).toBe(1);
  });

  test("holds the restart of decided approvals while the gate is closed", async () => {
    const text = await source();

    expect(text).toMatch(
      /sweepPendingApprovals\(\s*config,\s*discordWebhookUrl,\s*log,\s*stop,?\s*\)/,
    );
  });

  test("passes the closed gate to the approval sweep as the held restart", async () => {
    const text = await source();

    expect(text).toContain("redispatchHeld: holdsGate(stop)");
  });

  test("does not report a version mismatch while the stop-all holds the deploy", async () => {
    const text = await source();
    const start = text.indexOf("isDeployHeld: () =>");

    expect(text.slice(start, text.indexOf("nowMs:", start))).toContain(
      "holdsGate(await readStopAllBounded())",
    );
  });
});
