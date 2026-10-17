import { describe, expect, test } from "bun:test";
import {
  GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT,
  SELF_UPDATE_BOUNDED_CALL_COUNT,
  SELF_UPDATE_WORST_CASE_MS,
} from "../../f/factory/self_update.ts";

// `self_update`は、更新の成否によらず、finallyの最後の文でGitHubの収集の鮮度を確かめる。
// 確認の中の区切った呼び出しは、確認全体の上限に包まれる前提で、最悪の長さに数えない。
// その前提(最後の文であること、子プロセスを起動しないこと)をソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。

async function selfUpdateSource(): Promise<string> {
  return Bun.file("f/factory/self_update.ts").text();
}

/** `finally`の節。更新が例外を投げても確認が走ることを確かめるために切り出す。 */
function finallyBlock(source: string): string {
  const start = source.indexOf("} finally {");
  return start < 0 ? "" : source.slice(start);
}

/** 呼び出しの開きの行の字下げ。 */
function indentOf(source: string, at: number): string {
  const lineStart = source.lastIndexOf("\n", at) + 1;
  return source.slice(lineStart).match(/^ */)?.[0] ?? "";
}

/** `checkGhCollectFreshness(`の呼び出しの節。開きから、同じ字下げの`});`まで。見つからなければ空。 */
function callSection(source: string): string {
  const start = finallyBlock(source).indexOf("checkGhCollectFreshness(");
  if (start < 0) return "";
  const block = finallyBlock(source);
  const close = block.indexOf(`\n${indentOf(block, start)}});`, start);
  return close < 0 ? "" : block.slice(start, close + 1);
}

/** 呼び出しの節より後から、`main`の終わり(行頭の`}`)まで。 */
function afterCall(source: string): string {
  const block = finallyBlock(source);
  const section = callSection(source);
  if (section.length === 0) return "";
  const from = block.indexOf(section) + section.length;
  const end = block.indexOf("\n}", from);
  return end < 0 ? "" : block.slice(from, end);
}

describe("self_update gh collect freshness check", () => {
  test("runs the check in the finally block", async () => {
    expect(finallyBlock(await selfUpdateSource())).toContain(
      "checkGhCollectFreshness(",
    );
  });

  test("runs the check after the periodic worker check", async () => {
    const block = finallyBlock(await selfUpdateSource());
    expect(block.indexOf("checkPeriodicWorker(")).toBeLessThan(
      block.indexOf("checkGhCollectFreshness("),
    );
  });

  test("passes the periodic worker result", async () => {
    expect(callSection(await selfUpdateSource())).toContain(
      'periodicStalled: periodicWorker === "stalled"',
    );
  });

  test("wraps the check in try and catch", async () => {
    const block = finallyBlock(await selfUpdateSource());
    const start = block.indexOf("checkGhCollectFreshness(");
    expect(block.slice(block.lastIndexOf("try {", start), start)).toMatch(
      /try \{\s*await $/,
    );
  });

  test("catches a failure of the check with a fixed log", async () => {
    expect(afterCall(await selfUpdateSource())).toContain("catch");
  });

  test("fixes the resolved kind to github_collect_stale", async () => {
    expect(callSection(await selfUpdateSource())).toMatch(
      /resolveUnresolvedNoticesByPrefix\(\s*GH_COLLECT_STALE_KIND,/,
    );
  });

  test("fixes the listed kind to github_collect_stale", async () => {
    expect(callSection(await selfUpdateSource())).toMatch(
      /listUnresolvedNoticesByKind\(\s*GH_COLLECT_STALE_KIND\s*\)/,
    );
  });

  test("counts the check timeout in the worst case", async () => {
    const source = await selfUpdateSource();
    const start = source.indexOf("export const SELF_UPDATE_WORST_CASE_MS");
    expect(source.slice(start, source.indexOf(";", start))).toContain(
      "GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS",
    );
  });

  test("excludes the check's bounded calls from the worst case", async () => {
    const source = await selfUpdateSource();
    const start = source.indexOf("export const SELF_UPDATE_WORST_CASE_MS");
    expect(source.slice(start, source.indexOf(";", start))).toContain(
      "- GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT",
    );
  });

  test("the check's bounded call sites match the count", async () => {
    const section = callSection(await selfUpdateSource());
    const bounded = (section.match(/withCallTimeout\(/g) ?? []).length;
    const notify = (section.match(/withCallTimeout\(\s*"notify"/g) ?? [])
      .length;
    expect(bounded - notify).toBe(GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT);
  });

  test("runs the check as the last statement of the finally block", async () => {
    expect(afterCall(await selfUpdateSource())).not.toContain("await ");
  });

  test("the check starts no child process", async () => {
    expect(callSection(await selfUpdateSource())).not.toMatch(
      /runCommand\(|spawn/,
    );
  });

  test("the check section exists", async () => {
    expect(callSection(await selfUpdateSource()).length).toBeGreaterThan(0);
  });

  test("counts seven bounded calls inside the check", () => {
    expect(GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT).toBe(7);
  });

  test("counts thirty-five bounded calls in total", () => {
    expect(SELF_UPDATE_BOUNDED_CALL_COUNT).toBe(35);
  });

  test("the worst case is 3066.2 seconds", () => {
    expect(SELF_UPDATE_WORST_CASE_MS).toBe(3_066_200);
  });
});
