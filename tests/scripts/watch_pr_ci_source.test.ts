// `watch_pr_ci.ts`が、人のPRの候補を表で見つけるかを収集の設定から決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/pr_ci_watch.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../f/factory/lib/log.ts";
import { resolvePrCiHumanTableUse } from "../../f/factory/watch_pr_ci.ts";

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

describe("watch_pr_ci: the use of the table in the human discovery", () => {
  test("reads the table when the collection is fully enabled", () => {
    const { log } = capture();
    expect(resolvePrCiHumanTableUse(ENABLED, log)).toBe(true);
  });

  test("does not read the table when the collection is off", () => {
    const { log } = capture();
    expect(
      resolvePrCiHumanTableUse({ ...ENABLED, gh_collect_enabled: false }, log),
    ).toBe(false);
  });

  test("does not read the table when the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolvePrCiHumanTableUse(
        { ...ENABLED, gh_collect_detail_enabled: false },
        log,
      ),
    ).toBe(false);
  });

  test("warns with the names of the false settings when the table is not read", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanTableUse({ ...ENABLED, gh_collect_enabled: false }, log);
    expect(warnings).toEqual([
      {
        message:
          "the collection is not fully enabled, so the human discovery reads only the repositories that the config names",
        fields: { gh_collect_enabled: false, gh_collect_detail_enabled: true },
      },
    ]);
  });

  test("does not warn when the collection is on", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanTableUse(ENABLED, log);
    expect(warnings).toEqual([]);
  });

  test("does not warn when the human discovery is off", () => {
    const { log, warnings } = capture();
    resolvePrCiHumanTableUse(
      {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
        pr_ci_watch_human_prs: false,
      },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("watch_pr_ci: the wiring of the human discovery", () => {
  test("decides the use of the table from the settings", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain(
      "useTable: resolvePrCiHumanTableUse(config, log),",
    );
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

  test("passes a list of the open pull requests that does not wait for the rate limit", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source).toContain(
      "listOpenPullRequestsWithoutWait(client, owner, repo)",
    );
  });
});

describe("watch_pr_ci does not use the search API", () => {
  const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

  test("imports no name that starts with search from github.ts", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    const names = (githubImport.exec(source)?.[1] ?? "")
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim());
    expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
  });

  test("does not call the search endpoint", async () => {
    const source = await read("f/factory/watch_pr_ci.ts");
    expect(source.includes("search/issues")).toBe(false);
  });

  test("the watch has no dependency on a search of pull requests", async () => {
    const source = await read("f/factory/lib/pr_ci_watch.ts");
    expect(
      /searchHumanScope|HumanSearchState|OpenAuthoredPr|\bsearch:/.test(source),
    ).toBe(false);
  });

  test("the watch no longer reports a rate limit of the search", async () => {
    const source = await read("f/factory/lib/pr_ci_watch.ts");
    expect(source.includes("human_search_rate_limited")).toBe(false);
  });
});

describe("watch_pr_ci: the result", () => {
  test("no longer reports a source of the human discovery", async () => {
    const source = await read("f/factory/lib/pr_ci_watch.ts");
    expect(/human_source|human_fallback/.test(source)).toBe(false);
  });

  test("reports whether the collection was off", async () => {
    const source = await read("f/factory/lib/pr_ci_watch.ts");
    expect(source).toContain("human_collect_disabled");
  });
});
