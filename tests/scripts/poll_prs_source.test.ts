// `poll_prs.ts`が、収集の設定から表を読むかを決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/poll_source.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

describe("poll_prs: the wiring of the discovery", () => {
  test("decides whether to read the table from the settings", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("const useTable = resolveTableUse(config, log);");
  });

  test("passes a reader of the owner rows to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner)",
    );
  });

  test("passes a lister of the open pull requests to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "listOpenPrs: (owner, repo) => listOpenPullRequests(client, owner, repo)",
    );
  });

  test("passes a reader of the teams of the viewer to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("getViewerTeams: () => getViewerTeams(client),");
  });

  test("keeps the confirmed pull requests in the state of the job", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("checkedPrs: {");
  });

  test("reads the state of the job for the confirmed pull requests", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("await wmill.getState()");
  });

  test("writes the state of the job for the confirmed pull requests", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("await wmill.setState(");
  });

  test("passes the policy of the authors to the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    const input = source.slice(
      source.indexOf("await discoverPrs("),
      source.indexOf("readOwnerPrs:"),
    );
    expect(input).toContain("labelerPolicy,");
  });

  test("builds the policy of the authors before the discovery", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(
      source.indexOf("labelerPolicyFor(viewer.login, config)"),
    ).toBeLessThan(source.indexOf("await discoverPrs("));
  });

  test("keeps the position of the next round in the state of the job", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain('"team_confirm_cursor"');
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

describe("poll_prs: the result", () => {
  test("reports whether the collection was off", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("collect_disabled: !useTable,");
  });

  test("reports the skipped repositories of the round", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("skipped_stale: discovered.stats.skipped_stale,");
  });

  test("reports the reasons of the skipped repositories", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "skipped_stale_reasons: discovered.stats.skipped_stale_reasons,",
    );
  });

  test("reports the repositories read by REST", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("rest_lists: discovered.stats.rest_lists,");
  });

  test("reports the reasons of the repositories read by REST", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("rest_reasons: discovered.stats.rest_reasons,");
  });

  test("reports the pull requests that only a team could have requested", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "team_unresolved: discovered.stats.team_unresolved,",
    );
  });

  test("reports the pull requests that were not confirmed because of the limit", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain("team_capped: discovered.stats.team_capped,");
  });

  test("reports the pull requests that were remembered", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source).toContain(
      "team_remembered: discovered.stats.team_remembered,",
    );
  });

  test("no longer reports a source of the round", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source.includes("pr_source")).toBe(false);
  });

  test("no longer reports fallback searches", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source.includes("fallback_searches")).toBe(false);
  });

  test("no longer reports the table statistics under the old names", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source.includes("table_candidates")).toBe(false);
  });
});

describe("poll_prs does not use the search API", () => {
  const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

  test("imports no name that starts with search from github.ts", async () => {
    const source = await read("f/factory/poll_prs.ts");
    const names = (githubImport.exec(source)?.[1] ?? "")
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim());
    expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
  });

  test("does not call the search endpoint", async () => {
    const source = await read("f/factory/poll_prs.ts");
    expect(source.includes("search/issues")).toBe(false);
  });

  test("the discovery has no dependency on a search", async () => {
    const source = await read("f/factory/lib/poll_source.ts");
    const discovery = source.slice(
      source.indexOf("export async function discoverPrs"),
    );
    expect(discovery.includes("searchPrs")).toBe(false);
  });
});
