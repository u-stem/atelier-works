// `poll_issues.ts`が、Issueを見つける元を設定と収集の設定から決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/poll_source.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../f/factory/lib/log.ts";
import { resolveIssueSource } from "../../f/factory/poll_issues.ts";

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

function capture() {
  const warnings: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    info() {},
    warn(message, fields) {
      warnings.push({ message, fields });
    },
    error() {},
  };
  return { log, warnings };
}

const ENABLED = { gh_collect_enabled: true, gh_collect_detail_enabled: true };

describe("poll_issues: the source of the round", () => {
  test("is db when the setting is db and the collection is on", () => {
    const { log } = capture();
    expect(
      resolveIssueSource({ ...ENABLED, gh_source_poll_issues: "db" }, log),
    ).toBe("db");
  });

  test("is search when the setting is search", () => {
    const { log } = capture();
    expect(
      resolveIssueSource({ ...ENABLED, gh_source_poll_issues: "search" }, log),
    ).toBe("search");
  });

  test("is search when the setting is db but the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolveIssueSource(
        {
          gh_collect_enabled: true,
          gh_collect_detail_enabled: false,
          gh_source_poll_issues: "db",
        },
        log,
      ),
    ).toBe("search");
  });

  test("warns with the names of the false settings when the source db is ignored", () => {
    const { log, warnings } = capture();
    resolveIssueSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: true,
        gh_source_poll_issues: "db",
      },
      log,
    );
    expect(warnings).toEqual([
      {
        message:
          "gh_source_poll_issues is db but the collection is not fully enabled, so the round searches",
        fields: { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      },
    ]);
  });

  test("does not warn when the setting is search", () => {
    const { log, warnings } = capture();
    resolveIssueSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
        gh_source_poll_issues: "search",
      },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("poll_issues: the wiring of the discovery", () => {
  test("decides the source from the settings", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("const source = resolveIssueSource(config, log);");
  });

  test("passes a reader of the owner rows to the discovery", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "readOwnerIssues: (owner) => readGhOwnerOpenIssues(owner)",
    );
  });

  test("uses the number of owners for the threshold", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "staleAfterMs: ghDetailStaleAfterMs(config.owners.length)",
    );
  });

  test("passes the source to the discovery and reports it", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("issue_source: source,");
  });

  test("reports the table statistics of the round", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("table_dropped: discovered.stats.table_dropped,");
  });

  test("does not call the search directly any more", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).not.toContain("rawCandidates.push");
  });
});
