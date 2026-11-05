import { describe, expect, test } from "bun:test";

// 自己更新の全停止の関門を、`self_update.ts`のソースの文字列照合で確かめる。
// `updateSelf`は外へ出していないので、呼び出しの位置と戻り値の形を見る。
// 呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。

async function source(): Promise<string> {
  return Bun.file("f/factory/self_update.ts").text();
}

function at(text: string, pattern: RegExp): number {
  const index = text.search(pattern);
  if (index < 0) throw new Error(`not found in self_update.ts: ${pattern}`);
  return index;
}

const STOP_CHECK = /withCallTimeout\(\s*"stop check"/;

describe("self_update stop-all gate", () => {
  test("checks the stop-all before reading the GitHub token", async () => {
    const text = await source();

    expect(at(text, STOP_CHECK)).toBeLessThan(
      at(text, /"getVariable github_token"/),
    );
  });

  test("checks the stop-all after the start is logged", async () => {
    const text = await source();

    expect(at(text, /"self_update started"/)).toBeLessThan(
      at(text, STOP_CHECK),
    );
  });

  test("checks the stop-all before the deploy freeze is read", async () => {
    const text = await source();

    expect(at(text, STOP_CHECK)).toBeLessThan(
      at(text, /await prepareFreezePlan\(/),
    );
  });

  test("reads the stop-all through the shared reader", async () => {
    const text = await source();

    expect(text).toContain("readStopAll(sdkStopAllReadIo())");
  });

  test("bounds the stop check with its own timeout", async () => {
    const text = await source();

    expect(text).toMatch(
      /withCallTimeout\(\s*"stop check",[\s\S]{0,120}STOP_ALL_CHECK_TIMEOUT_MS,\s*\)/,
    );
  });

  test("treats a timed-out stop check as unreadable", async () => {
    const text = await source();

    expect(text).toMatch(
      /\.catch\(\s*\(\): StopAllStatus => \(\{\s*kind: "unreadable"/,
    );
  });

  test("closes the gate through holdsGate", async () => {
    const text = await source();

    expect(text).toContain("if (holdsGate(stop)) {");
  });

  test("returns held with the stop_all reason", async () => {
    const text = await source();

    expect(text).toContain('{ outcome: "held", reason: "stop_all" }');
  });

  test("counts the stop check once in the worst case", async () => {
    const text = await source();
    const start = text.indexOf("export const SELF_UPDATE_WORST_CASE_MS");

    expect(
      text
        .slice(start, text.indexOf(";", start))
        .match(/STOP_ALL_CHECK_TIMEOUT_MS/g)?.length,
    ).toBe(1);
  });
});
