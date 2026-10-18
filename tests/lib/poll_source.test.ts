// `poll_issues`が、トリガーラベル付きのIssueを見つける元の切り替えのテスト。
// 表の候補をRESTで確かめ直すこと、使えない所有者を検索に戻すこと、検索の経路と同じ項目になることを確かめる。

import { describe, expect, test } from "bun:test";
import type { Issue, IssueSearchItem } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  confirmTableIssue,
  discoverIssues,
  issueKey,
} from "../../f/factory/lib/poll_source.ts";
import { filterByRepoAllowlist } from "../../f/factory/lib/poll_support.ts";
import type {
  FactoryOwner,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerRepoFreshnessRow,
} from "../../f/factory/lib/types.ts";

const MINUTE_MS = 60_000;
const DB_NOW = new Date("2026-10-18T00:00:00.000Z");
const STALE_AFTER_MS = 15 * MINUTE_MS;
const TOO_OLD = new Date(DB_NOW.getTime() - STALE_AFTER_MS - 1);
const REPO_ID = 4242;
const LABEL = "factory";

function tableRow(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    repo_id: REPO_ID,
    number: 3,
    state: "open",
    author_login: "alice",
    author_type: "User",
    author_id: 1001,
    created_at: new Date("2026-10-10T00:00:00.000Z"),
    updated_at: new Date("2026-10-11T00:00:00.000Z"),
    written_at: new Date("2026-10-11T00:00:00.000Z"),
    usable: true,
    ...overrides,
  };
}

function repoRow(
  repo: string,
  overrides: Partial<GhOwnerRepoFreshnessRow> = {},
): GhOwnerRepoFreshnessRow {
  return {
    repo,
    repo_id: REPO_ID,
    allowed: true,
    archived: false,
    gone: false,
    last_collected_at: new Date(DB_NOW.getTime() - 5 * MINUTE_MS),
    truncated: false,
    detail_failed: false,
    ...overrides,
  };
}

function snapshot(
  repos: readonly GhOwnerRepoFreshnessRow[],
  issues: readonly GhIssue[],
): GhOwnerOpenIssueSnapshot {
  return { db_now: DB_NOW, repos, issues };
}

/** GitHubが返す綴り(`Acme/Widgets`)の`getIssue`の応答。 */
function restIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `title ${String(number)}`,
    body: `body ${String(number)}`,
    htmlUrl: `https://github.com/Acme/Widgets/issues/${String(number)}`,
    state: "open",
    authorLogin: "alice",
    closedByLogin: null,
    closedByType: null,
    mergedAt: null,
    authorAssociation: null,
    labels: [LABEL],
    assignees: [],
    repository: { owner: "Acme", repo: "Widgets" },
    ...overrides,
  };
}

/** 検索が返す項目。綴りは`getIssue`の応答と同じ。 */
function searchItem(
  number: number,
  overrides: Partial<IssueSearchItem> = {},
): IssueSearchItem {
  return {
    owner: "Acme",
    repo: "Widgets",
    number,
    title: `title ${String(number)}`,
    body: `body ${String(number)}`,
    htmlUrl: `https://github.com/Acme/Widgets/issues/${String(number)}`,
    authorLogin: "alice",
    ...overrides,
  };
}

const ACME: FactoryOwner = { name: "Acme", kind: "org" };
const BETA: FactoryOwner = { name: "Beta", kind: "user" };

type Fixture = {
  /** 所有者名(小文字)ごとの検索の結果。`Error`なら失敗する。 */
  searches?: Record<string, IssueSearchItem[] | Error>;
  /** 所有者名(小文字)ごとの表の読み取り。`Error`なら失敗する。 */
  snapshots?: Record<string, GhOwnerOpenIssueSnapshot | Error>;
  /** `owner/repo#number`(小文字)ごとの`getIssue`の応答。 */
  issues?: Record<string, Issue | Error>;
};

type Options = {
  source?: "search" | "db";
  owners?: readonly FactoryOwner[];
  repoAllowlist?: string[];
  staleAfterMs?: number;
};

function scopeOf(owners: readonly FactoryOwner[], repoAllowlist: string[]) {
  return {
    owners: [...owners],
    repo_allowlist: repoAllowlist,
    factory_repo: "https://github.com/acme/widgets",
  };
}

async function run(fixture: Fixture, options: Options = {}) {
  const owners = options.owners ?? [ACME];
  const searched: string[] = [];
  const read: string[] = [];
  const got: string[] = [];
  const failures: string[] = [];
  const logs: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    info(message, fields) {
      logs.push({ message, fields });
    },
    warn() {},
    error() {},
  };
  const result = await discoverIssues(
    {
      source: options.source ?? "db",
      owners,
      scope: scopeOf(owners, options.repoAllowlist ?? []),
      triggerLabel: LABEL,
      staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS,
      log,
    },
    {
      searchIssues: async (owner) => {
        searched.push(owner.name);
        const found = fixture.searches?.[owner.name.toLowerCase()] ?? [];
        if (found instanceof Error) throw found;
        return found;
      },
      readOwnerIssues: async (owner) => {
        read.push(owner);
        const found = fixture.snapshots?.[owner.toLowerCase()];
        if (found === undefined) throw new Error("no snapshot");
        if (found instanceof Error) throw found;
        return found;
      },
      getIssue: async (owner, repo, number) => {
        const key = `${owner}/${repo}#${String(number)}`;
        got.push(key);
        const found = fixture.issues?.[key];
        if (found === undefined) throw new Error("no issue");
        if (found instanceof Error) throw found;
        return found;
      },
      recordFailure: async (step) => {
        failures.push(step);
      },
    },
  );
  return { result, searched, read, got, failures, logs };
}

/** 鮮度の足りるwidgetsの表に、指定の番号の行がある所有者。 */
function freshAcme(...numbers: number[]): GhOwnerOpenIssueSnapshot {
  return snapshot(
    [repoRow("widgets")],
    numbers.map((number) => tableRow({ id: number, number })),
  );
}

describe("issueKey", () => {
  test("lowercases the owner and the repository", () => {
    expect(issueKey("Acme", "Widgets", 3)).toBe("acme/widgets#3");
  });
});

describe("confirmTableIssue", () => {
  test("accepts an open issue with the trigger label and builds the item from the REST values", () => {
    const check = confirmTableIssue(tableRow(), restIssue(3), LABEL);
    expect(check).toEqual({ kind: "ok", item: searchItem(3) });
  });

  test("compares the trigger label without regard to case", () => {
    const check = confirmTableIssue(
      tableRow(),
      restIssue(3, { labels: ["Factory"] }),
      LABEL,
    );
    expect(check.kind).toBe("ok");
  });

  test("drops a closed issue", () => {
    const check = confirmTableIssue(
      tableRow(),
      restIssue(3, { state: "closed" }),
      LABEL,
    );
    expect(check).toEqual({ kind: "drop", reason: "closed" });
  });

  test("drops an issue whose trigger label is gone", () => {
    const check = confirmTableIssue(
      tableRow(),
      restIssue(3, { labels: ["bug"] }),
      LABEL,
    );
    expect(check).toEqual({ kind: "drop", reason: "label_absent" });
  });

  test("reports a mismatch when the repository is unknown", () => {
    const check = confirmTableIssue(
      tableRow(),
      restIssue(3, { repository: null }),
      LABEL,
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the repository differs from the row in lowercase", () => {
    const check = confirmTableIssue(
      tableRow(),
      restIssue(3, { repository: { owner: "Acme", repo: "Gadgets" } }),
      LABEL,
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the number differs from the row", () => {
    const check = confirmTableIssue(tableRow(), restIssue(4), LABEL);
    expect(check).toEqual({ kind: "mismatch" });
  });
});

describe("discoverIssues from a search", () => {
  test("searches every owner and reads neither the table nor the issues", async () => {
    const { searched, read, got } = await run(
      { searches: { acme: [searchItem(3)], beta: [] } },
      { source: "search", owners: [ACME, BETA] },
    );
    expect([searched, read, got]).toEqual([["Acme", "Beta"], [], []]);
  });

  test("returns the searched items", async () => {
    const { result } = await run(
      { searches: { acme: [searchItem(3)] } },
      { source: "search" },
    );
    expect(result.items).toEqual([searchItem(3)]);
  });

  test("records a failed search and goes on to the next owner", async () => {
    const { failures, result } = await run(
      { searches: { acme: new Error("boom"), beta: [searchItem(8)] } },
      { source: "search", owners: [ACME, BETA] },
    );
    expect([failures, result.failed, result.items.length]).toEqual([
      ["search_issues:Acme"],
      1,
      1,
    ]);
  });
});

describe("discoverIssues from the table", () => {
  test("does not search when every owner is fresh", async () => {
    const { searched } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    });
    expect(searched).toEqual([]);
  });

  test("returns the confirmed table candidates in the spelling of GitHub", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    });
    expect(result.items).toEqual([searchItem(3)]);
  });

  test("reads the issues with the lowercase names of the table", async () => {
    const { got } = await run({
      snapshots: { acme: freshAcme(3, 5) },
      issues: {
        "acme/widgets#3": restIssue(3),
        "acme/widgets#5": restIssue(5),
      },
    });
    expect(got).toEqual(["acme/widgets#3", "acme/widgets#5"]);
  });

  test("searches only the owner whose records are stale", async () => {
    const { searched } = await run(
      {
        snapshots: {
          acme: freshAcme(3),
          beta: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
        issues: { "acme/widgets#3": restIssue(3) },
      },
      { owners: [ACME, BETA] },
    );
    expect(searched).toEqual(["Beta"]);
  });

  test("records a failed read of the owner and searches that owner", async () => {
    const { failures, searched } = await run({
      snapshots: { acme: new Error("db down") },
    });
    expect([failures, searched]).toEqual([
      ["read_gh_owner_issues:Acme"],
      ["Acme"],
    ]);
  });

  test("counts a failed read as a failure of the round", async () => {
    const { result } = await run({
      snapshots: { acme: new Error("db down") },
    });
    expect(result.failed).toBe(1);
  });

  test("does not record a failure for stale records", async () => {
    const { failures } = await run({
      snapshots: {
        acme: snapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    });
    expect(failures).toEqual([]);
  });

  test("searches the owner when an explicit repository is not visible", async () => {
    const { searched } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets"), repoRow("gadgets", { gone: true })],
            [],
          ),
        },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(searched).toEqual(["Acme"]);
  });

  test("does not take the issues of an archived repository", async () => {
    const { result } = await run({
      snapshots: {
        acme: snapshot(
          [repoRow("widgets"), repoRow("old", { archived: true, gone: true })],
          [
            tableRow({ number: 3 }),
            tableRow({ id: 9, repo: "old", number: 9 }),
          ],
        ),
      },
      issues: { "acme/widgets#3": restIssue(3) },
    });
    expect(result.items.map((item) => item.number)).toEqual([3]);
  });

  test("does not take the issues of a repository that is not allowed now", async () => {
    const { got } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets"), repoRow("gadgets")],
            [
              tableRow({ number: 3 }),
              tableRow({ id: 9, repo: "gadgets", number: 9 }),
            ],
          ),
        },
        issues: { "acme/widgets#3": restIssue(3) },
      },
      { repoAllowlist: ["https://github.com/acme/widgets"] },
    );
    expect(got).toEqual(["acme/widgets#3"]);
  });

  test("drops a candidate that is no longer a target without a failure", async () => {
    const { result, failures } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3, { state: "closed" }) },
    });
    expect([result.items, failures]).toEqual([[], []]);
  });

  test("counts the dropped candidates", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3, 4) },
      issues: {
        "acme/widgets#3": restIssue(3, { labels: [] }),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect([result.stats.table_candidates, result.stats.table_dropped]).toEqual(
      [2, 1],
    );
  });

  test("records a failed read of an issue and drops only that candidate", async () => {
    const { result, failures } = await run({
      snapshots: { acme: freshAcme(3, 4) },
      issues: {
        "acme/widgets#3": new Error("boom"),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect([
      failures,
      result.items.map((item) => item.number),
      result.failed,
    ]).toEqual([["confirm_table_issue:acme/widgets#3"], [4], 1]);
  });

  test("records a mismatch as a failure and drops the candidate", async () => {
    const { result, failures } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3, { repository: null }) },
    });
    expect([failures, result.items]).toEqual([
      ["confirm_table_issue:acme/widgets#3"],
      [],
    ]);
  });

  test("records a failed fallback search and goes on to the next owner", async () => {
    const { failures, result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
        searches: { acme: new Error("boom"), beta: [searchItem(8)] },
      },
      { owners: [ACME, BETA] },
    );
    expect([failures, result.items.length]).toEqual([
      ["search_issues:Acme"],
      1,
    ]);
  });

  test("reports the number and the reasons of the fallback searches", async () => {
    const { result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: new Error("db down"),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect([
      result.stats.fallback_searches,
      result.stats.fallback_reasons,
    ]).toEqual([2, { too_old: 1, read_failed: 1 }]);
  });

  test("builds a new reason record for every round", async () => {
    const fixture = {
      snapshots: {
        acme: snapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    };
    const first = await run(fixture);
    const second = await run(fixture);
    expect(first.result.stats.fallback_reasons).not.toBe(
      second.result.stats.fallback_reasons,
    );
  });

  test("judges the freshness with the given threshold", async () => {
    const { searched } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      { staleAfterMs: STALE_AFTER_MS + 2 },
    );
    expect(searched).toEqual([]);
  });

  test("reports the source of the round", async () => {
    const { result } = await run({ snapshots: { acme: freshAcme() } });
    expect(result.stats.source).toBe("db");
  });
});

describe("the table and the search find the same issues", () => {
  /** 検索の経路と表の経路の項目を、許可リストを当ててから返す。 */
  async function both(
    fixture: Fixture,
    options: Options = {},
  ): Promise<{ search: IssueSearchItem[]; table: IssueSearchItem[] }> {
    const owners = options.owners ?? [ACME];
    const scope = scopeOf(owners, options.repoAllowlist ?? []);
    const search = await run(fixture, { ...options, source: "search" });
    const table = await run(fixture, { ...options, source: "db" });
    return {
      search: filterByRepoAllowlist(search.result.items, scope),
      table: filterByRepoAllowlist(table.result.items, scope),
    };
  }

  test("returns the same items for open issues with the trigger label", async () => {
    const { search, table } = await both({
      searches: { acme: [searchItem(3), searchItem(4)] },
      snapshots: { acme: freshAcme(3, 4) },
      issues: {
        "acme/widgets#3": restIssue(3),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect(table).toEqual(search);
  });

  test("drops stale rows by REST and agrees with a fresh search index", async () => {
    const { search, table } = await both({
      searches: { acme: [searchItem(3)] },
      snapshots: { acme: freshAcme(3, 4, 5) },
      issues: {
        "acme/widgets#3": restIssue(3),
        "acme/widgets#4": restIssue(4, { state: "closed" }),
        "acme/widgets#5": restIssue(5, { labels: ["bug"] }),
      },
    });
    expect(table).toEqual(search);
  });

  test("gives the owner and repository of the work item the spelling of the search", async () => {
    const { table } = await both({
      searches: { acme: [searchItem(3)] },
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    });
    expect(table.map((item) => `${item.owner}/${item.repo}`)).toEqual([
      "Acme/Widgets",
    ]);
  });

  test("agrees when the set includes a repository that is not allowed", async () => {
    const { search, table } = await both(
      {
        searches: {
          acme: [searchItem(3), searchItem(9, { repo: "Gadgets" })],
        },
        snapshots: {
          acme: snapshot(
            [repoRow("widgets"), repoRow("gadgets")],
            [
              tableRow({ number: 3 }),
              tableRow({ id: 9, repo: "gadgets", number: 9 }),
            ],
          ),
        },
        issues: {
          "acme/widgets#3": restIssue(3),
          "acme/gadgets#9": restIssue(9, {
            repository: { owner: "Acme", repo: "Gadgets" },
          }),
        },
      },
      { repoAllowlist: ["https://github.com/acme/widgets"] },
    );
    expect(table).toEqual(search);
  });

  test("agrees across several owners", async () => {
    const betaItem = searchItem(7, {
      owner: "Beta",
      repo: "Tools",
      htmlUrl: "https://github.com/Beta/Tools/issues/7",
    });
    const { search, table } = await both(
      {
        searches: { acme: [searchItem(3)], beta: [betaItem] },
        snapshots: {
          acme: freshAcme(3),
          beta: snapshot(
            [repoRow("tools")],
            [tableRow({ id: 7, owner: "beta", repo: "tools", number: 7 })],
          ),
        },
        issues: {
          "acme/widgets#3": restIssue(3),
          "beta/tools#7": restIssue(7, {
            repository: { owner: "Beta", repo: "Tools" },
            htmlUrl: "https://github.com/Beta/Tools/issues/7",
          }),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(table).toEqual(search);
  });
});

describe("the differences that are accepted", () => {
  test("a new issue that is not in the table yet is found by the search only", async () => {
    const fixture = {
      searches: { acme: [searchItem(3), searchItem(9)] },
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    };
    const search = await run(fixture, { source: "search" });
    const table = await run(fixture, { source: "db" });
    expect([
      search.result.items.map((item) => item.number),
      table.result.items.map((item) => item.number),
    ]).toEqual([[3, 9], [3]]);
  });

  test("an issue of an archived repository is found by the search only", async () => {
    const fixture = {
      searches: { acme: [searchItem(3), searchItem(9, { repo: "Old" })] },
      snapshots: {
        acme: snapshot(
          [repoRow("widgets"), repoRow("old", { archived: true })],
          [
            tableRow({ number: 3 }),
            tableRow({ id: 9, repo: "old", number: 9 }),
          ],
        ),
      },
      issues: { "acme/widgets#3": restIssue(3) },
    };
    const search = await run(fixture, { source: "search" });
    const table = await run(fixture, { source: "db" });
    expect([
      search.result.items.map((item) => item.number),
      table.result.items.map((item) => item.number),
    ]).toEqual([[3, 9], [3]]);
  });

  test("with an empty allowlist, a repository without a gh_repos row is missed by the table", async () => {
    const fixture = {
      searches: { acme: [searchItem(3), searchItem(9, { repo: "Stray" })] },
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    };
    const table = await run(fixture, { source: "db" });
    expect(table.result.items.map((item) => item.number)).toEqual([3]);
  });

  test("with an allowlist, the same repository is explicit and the owner goes back to the search", async () => {
    const fixture = {
      searches: { acme: [searchItem(3), searchItem(9, { repo: "Stray" })] },
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    };
    const table = await run(fixture, {
      source: "db",
      repoAllowlist: [
        "https://github.com/acme/widgets",
        "https://github.com/acme/stray",
      ],
    });
    expect(table.result.items.map((item) => item.number)).toEqual([3, 9]);
  });
});

describe("a stale table row does not become a false labeler denial", () => {
  test("drops a row whose label was removed, so that no labeler is read", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3, { labels: [] }) },
    });
    expect(result.items).toEqual([]);
  });
});

describe("the round does not stop when the table cannot be used", () => {
  const sameAsSearch = async (fixture: Fixture, options: Options = {}) => {
    const search = await run(fixture, { ...options, source: "search" });
    const table = await run(fixture, { ...options, source: "db" });
    return { search: search.result.items, table: table.result.items };
  };

  test("finds the issues by the search when every owner is too old", async () => {
    const { search, table } = await sameAsSearch(
      {
        searches: { acme: [searchItem(3)], beta: [searchItem(8)] },
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(table).toEqual(search);
  });

  test("finds the issues by the search when every read fails", async () => {
    const { search, table } = await sameAsSearch(
      {
        searches: { acme: [searchItem(3)], beta: [searchItem(8)] },
        snapshots: { acme: new Error("down"), beta: new Error("down") },
      },
      { owners: [ACME, BETA] },
    );
    expect(table).toEqual(search);
  });
});
