// `watch_pr_ci.ts`が、人のPRの候補を見つける元を設定と収集の設定から決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/pr_ci_watch.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../f/factory/lib/log.ts";
import { resolvePrCiHumanSource } from "../../f/factory/watch_pr_ci.ts";

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

const ENABLED = {
  gh_collect_enabled: true,
  gh_collect_detail_enabled: true,
  pr_ci_watch_human_prs: true,
};

describe("watch_pr_ci: the source of the human discovery", () => {
  test("is db when the setting is db and the collection is on", () => {
    const { log } = capture();
    expect(
      resolvePrCiHumanSource({ ...ENABLED, gh_source_pr_ci_watch: "db" }, log),
    ).toBe("db");
  });

  test("is search when the setting is search", () => {
    const { log } = capture();
    expect(
      resolvePrCiHumanSource(
        { ...ENABLED, gh_source_pr_ci_watch: "search" },
        log,
      ),
    ).toBe("search");
  });

  test("is search when the setting is db but the collection is off", () => {
    const { log } = capture();
    expect(
      resolvePrCiHumanSource(
        {
          gh_collect_enabled: false,
          gh_collect_detail_enabled: true,
          pr_ci_watch_human_prs: true,
          gh_source_pr_ci_watch: "db",
        },
        log,
      ),
    ).toBe("search");
  });

  test("warns with the names of the false settings when the source db is ignored", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: true,
        pr_ci_watch_human_prs: true,
        gh_source_pr_ci_watch: "db",
      },
      log,
    );
    expect(warnings).toEqual([
      {
        message:
          "gh_source_pr_ci_watch is db but the collection is not fully enabled, so the round searches",
        fields: { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      },
    ]);
  });

  test("does not warn when the collection is on", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanSource({ ...ENABLED, gh_source_pr_ci_watch: "db" }, log);
    expect(warnings).toEqual([]);
  });

  test("does not warn when the human discovery is off", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
        pr_ci_watch_human_prs: false,
        gh_source_pr_ci_watch: "db",
      },
      log,
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when the setting is search", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanSource(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
        pr_ci_watch_human_prs: true,
        gh_source_pr_ci_watch: "search",
      },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("watch_pr_ci: the wiring of the human discovery", () => {
  test("decides the source from the settings", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain("source: resolvePrCiHumanSource(config, log),");
  });

  test("uses the number of owners for the threshold", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain(
      "staleAfterMs: ghDetailStaleAfterMs(config.owners.length),",
    );
  });

  test("passes a reader of the owner rows to the discovery", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain(
      "readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner),",
    );
  });

  test("passes a reader of the repository rows to the discovery", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain(
      "readRepoPrs: (owner, repo) => readGhRepoOpenPullRequests(owner, repo),",
    );
  });

  test("calls the search only as a dependency of the discovery", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    const calls = [...source.matchAll(/searchOpenAuthoredPrs\(client/g)];
    expect(calls).toHaveLength(1);
  });
});
