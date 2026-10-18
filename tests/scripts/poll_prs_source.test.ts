// `poll_prs.ts`が、PRを見つける元を設定と収集の設定から決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/poll_source.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../f/factory/lib/log.ts";
import { resolvePrSource } from "../../f/factory/poll_prs.ts";

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

describe("poll_prs: the source of the round", () => {
  test("is db when the setting is db and the collection is on", () => {
    const { log } = capture();
    expect(resolvePrSource({ ...ENABLED, gh_source_poll_prs: "db" }, log)).toBe(
      "db",
    );
  });

  test("is search when the setting is search", () => {
    const { log } = capture();
    expect(
      resolvePrSource({ ...ENABLED, gh_source_poll_prs: "search" }, log),
    ).toBe("search");
  });

  test("is search when the setting is db but the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolvePrSource(
        {
          gh_collect_enabled: true,
          gh_collect_detail_enabled: false,
          gh_source_poll_prs: "db",
        },
        log,
      ),
    ).toBe("search");
  });

  test("warns with the names of the false settings when the source db is ignored", () => {
    const { log, warnings } = capture();
    resolvePrSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: true,
        gh_source_poll_prs: "db",
      },
      log,
    );
    expect(warnings).toEqual([
      {
        message:
          "gh_source_poll_prs is db but the collection is not fully enabled, so the round searches",
        fields: { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      },
    ]);
  });

  test("does not warn when the setting is search", () => {
    const { log, warnings } = capture();
    resolvePrSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
        gh_source_poll_prs: "search",
      },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("poll_prs: the wiring of the discovery", () => {
  test("decides the source from the settings", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("const source = resolvePrSource(config, log);");
  });

  test("passes a reader of the owner rows to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner)",
    );
  });

  test("uses the number of owners for the threshold", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "staleAfterMs: ghDetailStaleAfterMs(config.owners.length)",
    );
  });

  test("passes the viewer and the trigger labels to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "labels: { reviewLabel: config.review_label, fixLabel: config.fix_label },",
    );
  });

  test("reports the source of the round", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("pr_source: source,");
  });

  test("reports the table statistics of the round", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("table_dropped: discovered.stats.table_dropped,");
  });

  test("calls the search only as a dependency of the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    const calls = [...source.matchAll(/searchPrs\(client/g)].map(
      (match) => match.index,
    );
    const discovery = source.indexOf("await discoverPrs(");
    expect(calls.length === 1 && (calls[0] ?? -1) > discovery).toBe(true);
  });

  test("starts the candidates from the discovered items", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "const rawCandidates: PrSearchItem[] = [...discovered.items];",
    );
  });

  test("still adds the tracked pull requests that the discovery did not return", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("await listTrackedPrs(config.tracked_pr_days)");
  });
});
