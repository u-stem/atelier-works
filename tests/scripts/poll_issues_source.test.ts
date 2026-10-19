// `poll_issues.ts`が、収集の設定から表を読むかを決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/poll_source.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../f/factory/lib/log.ts";
import { resolveIssueTableUse } from "../../f/factory/poll_issues.ts";

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

describe("poll_issues: whether the round reads the table", () => {
  test("reads the table when the collection and its detail are on", () => {
    const { log } = capture();
    expect(
      resolveIssueTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(true);
  });

  test("does not read the table when the collection is off", () => {
    const { log } = capture();
    expect(
      resolveIssueTableUse(
        { gh_collect_enabled: false, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(false);
  });

  test("does not read the table when the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolveIssueTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: false },
        log,
      ),
    ).toBe(false);
  });

  test("warns with the names of the false settings when the table is not read", () => {
    const { log, warnings } = capture();
    resolveIssueTableUse(
      { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      log,
    );
    expect(warnings).toEqual([
      {
        message:
          "the collection is not fully enabled, so only explicit repositories are read",
        fields: { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      },
    ]);
  });

  test("does not warn when the table is read", () => {
    const { log, warnings } = capture();
    resolveIssueTableUse(
      { gh_collect_enabled: true, gh_collect_detail_enabled: true },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("poll_issues: the wiring of the discovery", () => {
  test("decides whether to read the table from the settings", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "const useTable = resolveIssueTableUse(config, log);",
    );
  });

  test("passes a reader of the owner rows to the discovery", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "readOwnerIssues: (owner) => readGhOwnerOpenIssues(owner)",
    );
  });

  test("passes a lister of the labeled issues to the discovery", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "listLabeledOpenIssues(client, owner, repo, label)",
    );
  });

  test("uses the number of owners for the threshold", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "staleAfterMs: ghDetailStaleAfterMs(config.owners.length)",
    );
  });

  test("reports whether the collection was off", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("collect_disabled: !useTable,");
  });

  test("reports the skipped repositories of the round", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("skipped_stale: discovered.stats.skipped_stale,");
  });

  test("reports the reasons of the skipped repositories", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain(
      "skipped_stale_reasons: discovered.stats.skipped_stale_reasons,",
    );
  });

  test("reports the repositories read by REST", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("rest_lists: discovered.stats.rest_lists,");
  });

  test("reports the reasons of the repositories read by REST", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source).toContain("rest_reasons: discovered.stats.rest_reasons,");
  });
});

describe("poll_issues does not use the search API", () => {
  const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

  test("imports no name that starts with search from github.ts", async () => {
    const source = await read("f/factory/poll_issues.ts");
    const names = (githubImport.exec(source)?.[1] ?? "")
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim());
    expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
  });

  test("does not call the search endpoint", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source.includes("search/issues")).toBe(false);
  });

  test("the discovery has no dependency on a search", async () => {
    const source = await read("f/factory/lib/poll_source.ts");
    const discovery = source.slice(
      source.indexOf("export async function discoverIssues"),
      source.indexOf("export type PollPrRowClass"),
    );
    expect(discovery.includes("searchIssues")).toBe(false);
  });
});

describe("poll_issues: the result", () => {
  test("no longer reports a source of the round", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source.includes("issue_source")).toBe(false);
  });

  test("no longer reports fallback searches", async () => {
    const source = await read("f/factory/poll_issues.ts");
    expect(source.includes("fallback_searches")).toBe(false);
  });
});
