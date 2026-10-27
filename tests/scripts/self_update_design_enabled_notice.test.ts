import { describe, expect, test } from "bun:test";

// `self_update`の`main`は、設定を読んだ直後に、`design_enabled`が偽として読まれたことの通知を
// 1つの上限で包んで整える。結線をソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

const OPENING = /withCallTimeout\(\s*"design notice check"/;

/** 通知の処理の区切りの節。開きから、上限の定数まで。見つからなければ空。 */
function noticeSection(source: string): string {
  const start = source.search(OPENING);
  if (start < 0) return "";
  const end = source.indexOf("DESIGN_NOTICE_CHECK_TIMEOUT_MS", start);
  return end < 0 ? "" : source.slice(start, end);
}

describe("self_update design_enabled notice wiring", () => {
  test("bounds the notice work by the design notice check timeout", async () => {
    expect(await selfUpdateSource()).toMatch(
      /withCallTimeout\(\s*"design notice check",[\s\S]*?DESIGN_NOTICE_CHECK_TIMEOUT_MS,?\s*\)/,
    );
  });

  test("passes whether the setting was ignored", async () => {
    expect(noticeSection(await selfUpdateSource())).toContain(
      "ignored: config.design_enabled_ignored",
    );
  });

  test("adds the notice with addNoticeUnlessUnresolved", async () => {
    expect(noticeSection(await selfUpdateSource())).toMatch(
      /addNotice: \(record\) =>\s*addNoticeUnlessUnresolved\(record\)/,
    );
  });

  test("lists the unresolved notices of the fixed kind", async () => {
    expect(noticeSection(await selfUpdateSource())).toMatch(
      /listUnresolvedNoticesByKind\(\s*DESIGN_ENABLED_IGNORED_NOTICE_KIND\s*\)/,
    );
  });

  test("resolves a notice as self_update", async () => {
    expect(noticeSection(await selfUpdateSource())).toMatch(
      /resolveNoticeIfUnresolved\(\s*id,\s*DESIGN_ENABLED_IGNORED_NOTICE_KIND,\s*"self_update",\s*\[\],?\s*\)/,
    );
  });

  test("passes the logger", async () => {
    expect(noticeSection(await selfUpdateSource())).toMatch(/\blog,?\s*\}\)/);
  });

  test("runs between loadConfig and updateSelf", async () => {
    const source = await selfUpdateSource();
    const between = source.slice(
      source.indexOf("await loadConfig("),
      source.indexOf("await updateSelf(log, config)"),
    );
    expect(between).toMatch(OPENING);
  });

  test("catches a failure of the notice work", async () => {
    const source = await selfUpdateSource();
    const start = source.search(OPENING);
    const end = source.indexOf("await updateSelf(log, config)", start);
    expect(source.slice(start, end)).toContain("catch");
  });
});
