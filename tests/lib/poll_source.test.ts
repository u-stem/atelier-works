// `poll_issues`が、トリガーラベル付きのIssueを見つける元の切り替えのテスト。
// 表の候補をRESTで確かめ直すこと、使えない所有者を検索に戻すこと、検索の経路と同じ項目になることを確かめる。

import { describe, expect, test } from "bun:test";
import type {
  Issue,
  IssueSearchItem,
  PrSearchItem,
  PullRequest,
  Viewer,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  classifyPollPrRow,
  confirmTableIssue,
  confirmTablePr,
  discoverIssues,
  discoverPrs,
  issueKey,
} from "../../f/factory/lib/poll_source.ts";
import {
  decidePrActions,
  filterByRepoAllowlist,
  type LabelerPolicy,
  type PrCandidate,
} from "../../f/factory/lib/poll_support.ts";
import type {
  FactoryOwner,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
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

describe("a table row whose trigger label was removed", () => {
  test("yields no item", async () => {
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

const VIEWER_ID = 5001;
const OTHER_ID = 7777;

/** 検索のどの条件にも当たらない、開いたPRの行。 */
function prRow(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    repo_id: REPO_ID,
    number: 3,
    state: "open",
    head_sha: "a".repeat(40),
    head_ref: "feature",
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "alice",
    author_type: "User",
    author_id: 1001,
    mergeable: null,
    has_review_label: false,
    has_fix_label: false,
    review_requested_user_ids: [],
    assignee_ids: [],
    team_review_requested: false,
    created_at: new Date("2026-10-10T00:00:00.000Z"),
    updated_at: new Date("2026-10-11T00:00:00.000Z"),
    written_at: new Date("2026-10-11T00:00:00.000Z"),
    usable: true,
    ...overrides,
  };
}

describe("classifyPollPrRow", () => {
  test("is a target when the review label is on", () => {
    expect(
      classifyPollPrRow(prRow({ has_review_label: true }), VIEWER_ID),
    ).toBe("target");
  });

  test("is a target when the fix label is on", () => {
    expect(classifyPollPrRow(prRow({ has_fix_label: true }), VIEWER_ID)).toBe(
      "target",
    );
  });

  test("is a target when the viewer is a requested reviewer", () => {
    expect(
      classifyPollPrRow(
        prRow({ review_requested_user_ids: [OTHER_ID, VIEWER_ID] }),
        VIEWER_ID,
      ),
    ).toBe("target");
  });

  test("is a target when the viewer is an assignee", () => {
    expect(
      classifyPollPrRow(prRow({ assignee_ids: [VIEWER_ID] }), VIEWER_ID),
    ).toBe("target");
  });

  test("is none when only other people are requested and assigned", () => {
    expect(
      classifyPollPrRow(
        prRow({
          review_requested_user_ids: [OTHER_ID],
          assignee_ids: [OTHER_ID],
        }),
        VIEWER_ID,
      ),
    ).toBe("none");
  });

  test("is team when a team review is requested and nothing else matches", () => {
    expect(
      classifyPollPrRow(prRow({ team_review_requested: true }), VIEWER_ID),
    ).toBe("team");
  });

  test("is team when it is unknown whether a team review is requested", () => {
    expect(
      classifyPollPrRow(prRow({ team_review_requested: null }), VIEWER_ID),
    ).toBe("team");
  });

  test("is a target when a team review is requested but a label is on", () => {
    expect(
      classifyPollPrRow(
        prRow({ team_review_requested: true, has_review_label: true }),
        VIEWER_ID,
      ),
    ).toBe("target");
  });

  test("is maybe when it is unknown whether the review label is on", () => {
    expect(
      classifyPollPrRow(prRow({ has_review_label: null }), VIEWER_ID),
    ).toBe("maybe");
  });

  test("is maybe when the assignees are unknown", () => {
    expect(classifyPollPrRow(prRow({ assignee_ids: null }), VIEWER_ID)).toBe(
      "maybe",
    );
  });

  test("classifies a draft pull request from a fork like any other", () => {
    expect(
      classifyPollPrRow(
        prRow({
          is_draft: true,
          is_cross_repository: true,
          has_fix_label: true,
        }),
        VIEWER_ID,
      ),
    ).toBe("target");
  });

  test("is team when the requested reviewers are unknown even if the team flag is false", () => {
    expect(
      classifyPollPrRow(
        prRow({
          team_review_requested: false,
          review_requested_user_ids: null,
        }),
        VIEWER_ID,
      ),
    ).toBe("team");
  });
});

const REVIEW_LABEL = "factory:review";
const FIX_LABEL = "factory:fix";
const PR_LABELS = { reviewLabel: REVIEW_LABEL, fixLabel: FIX_LABEL };
const VIEWER: Viewer = { login: "Stem-Bot", id: VIEWER_ID };

/** `getPr`の応答。依頼先は誰も無い。 */
function restPr(
  number: number,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    title: `pr title ${String(number)}`,
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: "b".repeat(40),
    headRef: "feature",
    headRepoFullName: "Acme/Widgets",
    baseRepoFullName: "Acme/Widgets",
    baseRepoId: REPO_ID,
    baseRef: "main",
    mergeable: null,
    mergeableState: null,
    authorLogin: "alice",
    authorId: 1001,
    authorType: "User",
    autoMergeEnabled: false,
    requestedReviewerIds: [],
    ...overrides,
  };
}

/** PRを`getIssue`で読んだ応答。ラベルとassigneeはここから読む。 */
function restPrAsIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return restIssue(number, {
    htmlUrl: `https://github.com/Acme/Widgets/pull/${String(number)}`,
    labels: [],
    ...overrides,
  });
}

describe("confirmTablePr", () => {
  const row = prRow({ number: 3 });
  const confirm = (
    pr: PullRequest,
    asIssue: Issue,
  ): ReturnType<typeof confirmTablePr> =>
    confirmTablePr(row, pr, asIssue, VIEWER, PR_LABELS);

  test("accepts an open pull request with the review label", () => {
    const check = confirm(
      restPr(3),
      restPrAsIssue(3, { labels: [REVIEW_LABEL] }),
    );
    expect(check.kind).toBe("ok");
  });

  test("accepts an open pull request with the fix label", () => {
    const check = confirm(restPr(3), restPrAsIssue(3, { labels: [FIX_LABEL] }));
    expect(check.kind).toBe("ok");
  });

  test("accepts an assignee whose login differs only in case", () => {
    const check = confirm(
      restPr(3),
      restPrAsIssue(3, { assignees: ["stem-bot"] }),
    );
    expect(check.kind).toBe("ok");
  });

  test("accepts a pull request that requests the viewer", () => {
    const check = confirm(
      restPr(3, { requestedReviewerIds: [OTHER_ID, VIEWER_ID] }),
      restPrAsIssue(3),
    );
    expect(check.kind).toBe("ok");
  });

  test("drops a closed pull request", () => {
    const check = confirm(
      restPr(3, { state: "closed" }),
      restPrAsIssue(3, { labels: [REVIEW_LABEL] }),
    );
    expect(check).toEqual({ kind: "drop", reason: "closed" });
  });

  test("drops a pull request that has no label, request or assignee for the viewer", () => {
    const check = confirm(
      restPr(3, { requestedReviewerIds: [OTHER_ID] }),
      restPrAsIssue(3, { assignees: ["someone-else"] }),
    );
    expect(check).toEqual({ kind: "drop", reason: "not_target" });
  });

  test("cannot decide when the reviewers are unreadable and nothing else matches", () => {
    const check = confirm(
      restPr(3, { requestedReviewerIds: null }),
      restPrAsIssue(3),
    );
    expect(check).toEqual({ kind: "unknown_reviewers" });
  });

  test("accepts by the label even when the reviewers are unreadable", () => {
    const check = confirm(
      restPr(3, { requestedReviewerIds: null }),
      restPrAsIssue(3, { labels: [REVIEW_LABEL] }),
    );
    expect(check.kind).toBe("ok");
  });

  test("reports a mismatch when the repository differs from the row in lowercase", () => {
    const check = confirm(
      restPr(3),
      restPrAsIssue(3, {
        labels: [REVIEW_LABEL],
        repository: { owner: "Acme", repo: "Gadgets" },
      }),
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the repository is unknown", () => {
    const check = confirm(
      restPr(3),
      restPrAsIssue(3, { labels: [REVIEW_LABEL], repository: null }),
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the number differs from the row", () => {
    const check = confirm(
      restPr(4),
      restPrAsIssue(4, { labels: [REVIEW_LABEL] }),
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("builds the item with the spelling of GitHub and the title of the pull request", () => {
    const check = confirm(
      restPr(3),
      restPrAsIssue(3, { labels: [REVIEW_LABEL] }),
    );
    const expected: PrSearchItem = {
      owner: "Acme",
      repo: "Widgets",
      number: 3,
      title: "pr title 3",
      htmlUrl: "https://github.com/Acme/Widgets/pull/3",
    };
    expect(check).toEqual({ kind: "ok", item: expected });
  });
});

// ---------------------------------------------------------------------------
// discoverPrs
// ---------------------------------------------------------------------------

function prSnapshot(
  repos: readonly GhOwnerRepoFreshnessRow[],
  prs: readonly GhPullRequest[],
): GhOwnerOpenPrSnapshot {
  return { db_now: DB_NOW, repos, prs };
}

/** 検索が返す項目。綴りは`getPr`の応答と同じ。 */
function prSearchItem(
  number: number,
  overrides: Partial<PrSearchItem> = {},
): PrSearchItem {
  return {
    owner: "Acme",
    repo: "Widgets",
    number,
    title: `pr title ${String(number)}`,
    htmlUrl: `https://github.com/Acme/Widgets/pull/${String(number)}`,
    ...overrides,
  };
}

type PrFixture = {
  /** 所有者名(小文字)ごとの検索の結果。`Error`なら失敗する。 */
  searches?: Record<string, PrSearchItem[] | Error>;
  /** 所有者名(小文字)ごとの表の読み取り。`Error`なら失敗する。 */
  snapshots?: Record<string, GhOwnerOpenPrSnapshot | Error>;
  /** `owner/repo#number`(小文字)ごとの`getPr`の応答。 */
  prs?: Record<string, PullRequest | Error>;
  /** `owner/repo#number`(小文字)ごとの、PRを`getIssue`で読んだ応答。 */
  issues?: Record<string, Issue | Error>;
};

type PrOptions = {
  source?: "search" | "db";
  owners?: readonly FactoryOwner[];
  repoAllowlist?: string[];
  staleAfterMs?: number;
  /** 既定の偽物の代わりに使う`getPr`と`getIssue`。 */
  rest?: {
    getPr?: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<PullRequest>;
    getIssue?: (owner: string, repo: string, number: number) => Promise<Issue>;
  };
};

async function runPrs(fixture: PrFixture, options: PrOptions = {}) {
  const owners = options.owners ?? [ACME];
  const searched: string[] = [];
  const read: string[] = [];
  const gotPr: string[] = [];
  const gotIssue: string[] = [];
  const failures: string[] = [];
  const logs: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    info(message, fields) {
      logs.push({ message, fields });
    },
    warn() {},
    error() {},
  };
  const result = await discoverPrs(
    {
      source: options.source ?? "db",
      owners,
      scope: scopeOf(owners, options.repoAllowlist ?? []),
      viewer: VIEWER,
      labels: PR_LABELS,
      staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS,
      log,
    },
    {
      searchPrs: async (owner) => {
        searched.push(owner.name);
        const found = fixture.searches?.[owner.name.toLowerCase()] ?? [];
        if (found instanceof Error) throw found;
        return found;
      },
      readOwnerPrs: async (owner) => {
        read.push(owner);
        const found = fixture.snapshots?.[owner.toLowerCase()];
        if (found === undefined) throw new Error("no snapshot");
        if (found instanceof Error) throw found;
        return found;
      },
      getPr:
        options.rest?.getPr ??
        (async (owner, repo, number) => {
          const key = `${owner}/${repo}#${String(number)}`;
          gotPr.push(key);
          const found = fixture.prs?.[key];
          if (found === undefined) throw new Error("no pull request");
          if (found instanceof Error) throw found;
          return found;
        }),
      getIssue:
        options.rest?.getIssue ??
        (async (owner, repo, number) => {
          const key = `${owner}/${repo}#${String(number)}`;
          gotIssue.push(key);
          const found = fixture.issues?.[key];
          if (found === undefined) throw new Error("no issue");
          if (found instanceof Error) throw found;
          return found;
        }),
      recordFailure: async (step) => {
        failures.push(step);
      },
    },
  );
  return { result, searched, read, gotPr, gotIssue, failures, logs };
}

type PrCaseOptions = {
  labels?: string[];
  assignedToViewer?: boolean;
  requestsViewer?: boolean;
  team?: boolean;
  closed?: boolean;
  fork?: boolean;
  draft?: boolean;
  author?: string;
  /** 表の行は対象と言うが、RESTでは対象でなくなっている。 */
  staleRow?: boolean;
};

/** 表の行、RESTの応答、検索の結果を、同じPRについて整合させて作る。 */
function prCase(number: number, options: PrCaseOptions = {}) {
  const labels = options.labels ?? [];
  const live = options.staleRow !== true;
  const row = prRow({
    id: number,
    number,
    has_review_label: labels.includes(REVIEW_LABEL),
    has_fix_label: labels.includes(FIX_LABEL),
    review_requested_user_ids: options.requestsViewer
      ? [VIEWER_ID]
      : [OTHER_ID],
    assignee_ids: options.assignedToViewer ? [VIEWER_ID] : [],
    team_review_requested: options.team ?? false,
    is_draft: options.draft ?? false,
    is_cross_repository: options.fork ?? false,
    author_login: options.author ?? "alice",
  });
  const pr = restPr(number, {
    state: options.closed ? "closed" : "open",
    draft: options.draft ?? false,
    headRepoFullName: options.fork ? "forker/Widgets" : "Acme/Widgets",
    authorLogin: options.author ?? "alice",
    requestedReviewerIds: live && options.requestsViewer ? [VIEWER_ID] : [],
  });
  const asIssue = restPrAsIssue(number, {
    labels: live ? labels : [],
    assignees: live && options.assignedToViewer ? [VIEWER.login] : [],
  });
  const matchesSearch =
    options.closed !== true &&
    live &&
    (labels.length > 0 ||
      options.assignedToViewer === true ||
      options.requestsViewer === true ||
      options.team === true);
  return { row, pr, asIssue, item: prSearchItem(number), matchesSearch };
}

type PrCase = ReturnType<typeof prCase>;

/** 所有者`acme`の`widgets`について、検索の結果と表とRESTを同じPRの集合から作る。 */
function prWorld(cases: readonly PrCase[]): PrFixture {
  const prs: Record<string, PullRequest> = {};
  const issues: Record<string, Issue> = {};
  for (const found of cases) {
    const key = `acme/widgets#${String(found.item.number)}`;
    prs[key] = found.pr;
    issues[key] = found.asIssue;
  }
  return {
    searches: {
      acme: cases.filter((found) => found.matchesSearch).map((c) => c.item),
    },
    snapshots: {
      acme: prSnapshot(
        [repoRow("widgets")],
        cases.map((found) => found.row),
      ),
    },
    prs,
    issues,
  };
}

describe("discoverPrs from a search", () => {
  test("searches every owner and reads neither the table nor the pull requests", async () => {
    const { searched, read, gotPr, gotIssue } = await runPrs(
      { searches: { acme: [prSearchItem(3)], beta: [] } },
      { source: "search", owners: [ACME, BETA] },
    );
    expect([searched, read, gotPr, gotIssue]).toEqual([
      ["Acme", "Beta"],
      [],
      [],
      [],
    ]);
  });

  test("returns the searched items", async () => {
    const { result } = await runPrs(
      { searches: { acme: [prSearchItem(3)] } },
      { source: "search" },
    );
    expect(result.items).toEqual([prSearchItem(3)]);
  });

  test("records a failed search and goes on to the next owner", async () => {
    const { failures, result } = await runPrs(
      { searches: { acme: new Error("boom"), beta: [prSearchItem(8)] } },
      { source: "search", owners: [ACME, BETA] },
    );
    expect([failures, result.failed, result.items.length]).toEqual([
      ["search_prs:Acme"],
      1,
      1,
    ]);
  });
});

describe("discoverPrs from the table", () => {
  const target = prCase(3, { labels: [REVIEW_LABEL] });

  test("does not search when every owner is fresh", async () => {
    const { searched } = await runPrs(prWorld([target]));
    expect(searched).toEqual([]);
  });

  test("returns the confirmed table candidates in the spelling of GitHub", async () => {
    const { result } = await runPrs(prWorld([target]));
    expect(result.items).toEqual([prSearchItem(3)]);
  });

  test("returns only the fields of a search item", async () => {
    const { result } = await runPrs(prWorld([target]));
    expect(Object.keys(result.items[0] ?? {}).sort()).toEqual([
      "htmlUrl",
      "number",
      "owner",
      "repo",
      "title",
    ]);
  });

  test("reads the pull requests with the lowercase names of the table", async () => {
    const second = prCase(5, { assignedToViewer: true });
    const { gotPr, gotIssue } = await runPrs(prWorld([target, second]));
    expect([gotPr, gotIssue]).toEqual([
      ["acme/widgets#3", "acme/widgets#5"],
      ["acme/widgets#3", "acme/widgets#5"],
    ]);
  });

  test("does not read a row that matches none of the four searches", async () => {
    const { gotPr } = await runPrs(prWorld([target, prCase(4)]));
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("confirms a row whose labels or assignees are unknown by REST", async () => {
    const unknown = prCase(6, { labels: [REVIEW_LABEL] });
    const world = prWorld([
      {
        ...unknown,
        row: { ...unknown.row, has_review_label: null, assignee_ids: null },
      },
    ]);
    const { result } = await runPrs(world);
    expect(result.items).toEqual([prSearchItem(6)]);
  });

  test("searches only the owner whose records are stale", async () => {
    const { searched } = await runPrs(
      {
        ...prWorld([target]),
        snapshots: {
          acme: prSnapshot([repoRow("widgets")], [target.row]),
          beta: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(searched).toEqual(["Beta"]);
  });

  test("searches an owner that has a team review request", async () => {
    const team = prCase(4, { team: true });
    const { searched, result } = await runPrs({
      ...prWorld([target, team]),
      searches: { acme: [prSearchItem(3), prSearchItem(4)] },
    });
    expect([searched, result.stats.fallback_reasons]).toEqual([
      ["Acme"],
      { team_review: 1 },
    ]);
  });

  test("reads neither the pull request nor the issue of an owner that goes back to the search", async () => {
    const team = prCase(4, { team: true });
    const { gotPr, gotIssue } = await runPrs({
      ...prWorld([target, team]),
      searches: { acme: [prSearchItem(3), prSearchItem(4)] },
    });
    expect([gotPr, gotIssue]).toEqual([[], []]);
  });

  test("returns the searched items only, not the table candidates too, for such an owner", async () => {
    const team = prCase(4, { team: true });
    const { result } = await runPrs({
      ...prWorld([target, team]),
      searches: { acme: [prSearchItem(3), prSearchItem(4)] },
    });
    expect(result.items.map((item) => item.number)).toEqual([3, 4]);
  });

  test("goes back to the search when the requested reviewers of a row are unknown", async () => {
    const unknown = prCase(4);
    const { searched } = await runPrs({
      ...prWorld([target]),
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets")],
          [{ ...unknown.row, review_requested_user_ids: null }],
        ),
      },
    });
    expect(searched).toEqual(["Acme"]);
  });

  test("records a failed read of the owner and searches that owner", async () => {
    const { failures, searched } = await runPrs({
      snapshots: { acme: new Error("db down") },
    });
    expect([failures, searched]).toEqual([
      ["read_gh_owner_prs:Acme"],
      ["Acme"],
    ]);
  });

  test("counts a failed read as a failure of the round", async () => {
    const { result } = await runPrs({
      snapshots: { acme: new Error("db down") },
    });
    expect(result.failed).toBe(1);
  });

  test("does not record a failure for stale records", async () => {
    const { failures } = await runPrs({
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    });
    expect(failures).toEqual([]);
  });

  test("searches the owner when an explicit repository is not visible", async () => {
    const { searched } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
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

  test("searches the owner when an explicit repository has no record", async () => {
    const { searched } = await runPrs(
      { snapshots: { acme: prSnapshot([repoRow("widgets")], []) } },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(searched).toEqual(["Acme"]);
  });

  test("takes neither a candidate nor a team request from an archived repository", async () => {
    const stray = prCase(9, { team: true });
    const { searched, gotPr } = await runPrs({
      ...prWorld([target]),
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets"), repoRow("old", { archived: true })],
          [target.row, { ...stray.row, repo: "old" }],
        ),
      },
    });
    expect([searched, gotPr]).toEqual([[], ["acme/widgets#3"]]);
  });

  test("takes neither a candidate nor a team request from a repository that is not allowed now", async () => {
    const stray = prCase(9, { team: true });
    const { searched, gotPr } = await runPrs(
      {
        ...prWorld([target]),
        snapshots: {
          acme: prSnapshot(
            [repoRow("widgets"), repoRow("gadgets")],
            [target.row, { ...stray.row, repo: "gadgets" }],
          ),
        },
      },
      { repoAllowlist: ["https://github.com/acme/widgets"] },
    );
    expect([searched, gotPr]).toEqual([[], ["acme/widgets#3"]]);
  });

  test("drops a candidate that is no longer a target without a failure", async () => {
    const stale = prCase(3, { labels: [REVIEW_LABEL], staleRow: true });
    const { result, failures } = await runPrs(prWorld([stale]));
    expect([result.items, failures]).toEqual([[], []]);
  });

  test("counts the dropped candidates", async () => {
    const stale = prCase(4, { labels: [REVIEW_LABEL], staleRow: true });
    const { result } = await runPrs(prWorld([target, stale]));
    expect([result.stats.table_candidates, result.stats.table_dropped]).toEqual(
      [2, 1],
    );
  });

  test("records a failed read of a pull request and drops only that candidate", async () => {
    const second = prCase(4, { labels: [REVIEW_LABEL] });
    const world = prWorld([target, second]);
    const { result, failures } = await runPrs({
      ...world,
      prs: { ...world.prs, "acme/widgets#3": new Error("boom") },
    });
    expect([
      failures,
      result.items.map((item) => item.number),
      result.failed,
    ]).toEqual([["confirm_table_pr:acme/widgets#3"], [4], 1]);
  });

  test("records a failed read of an issue and drops only that candidate", async () => {
    const second = prCase(4, { labels: [REVIEW_LABEL] });
    const world = prWorld([target, second]);
    const { result, failures } = await runPrs({
      ...world,
      issues: { ...world.issues, "acme/widgets#3": new Error("boom") },
    });
    expect([failures, result.items.map((item) => item.number)]).toEqual([
      ["confirm_table_pr:acme/widgets#3"],
      [4],
    ]);
  });

  test("records a mismatch as a failure and counts it", async () => {
    const world = prWorld([target]);
    const { result, failures } = await runPrs({
      ...world,
      issues: {
        "acme/widgets#3": restPrAsIssue(3, {
          labels: [REVIEW_LABEL],
          repository: null,
        }),
      },
    });
    expect([failures, result.items, result.failed]).toEqual([
      ["confirm_table_pr:acme/widgets#3"],
      [],
      1,
    ]);
  });

  test("records unreadable reviewers as a failure instead of dropping the candidate", async () => {
    const requested = prCase(3, { requestsViewer: true });
    const world = prWorld([requested]);
    const { result, failures } = await runPrs({
      ...world,
      prs: { "acme/widgets#3": restPr(3, { requestedReviewerIds: null }) },
    });
    expect([failures, result.failed, result.stats.table_dropped]).toEqual([
      ["confirm_table_pr:acme/widgets#3"],
      1,
      0,
    ]);
  });

  test("records a failed fallback search and goes on to the next owner", async () => {
    const { failures, result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
        searches: { acme: new Error("boom"), beta: [prSearchItem(8)] },
      },
      { owners: [ACME, BETA] },
    );
    expect([failures, result.items.length]).toEqual([["search_prs:Acme"], 1]);
  });

  test("reports the number and the reasons of the fallback searches", async () => {
    const { result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
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
        acme: prSnapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    };
    const first = await runPrs(fixture);
    const second = await runPrs(fixture);
    expect(first.result.stats.fallback_reasons).not.toBe(
      second.result.stats.fallback_reasons,
    );
  });

  test("judges the freshness with the given threshold", async () => {
    const { searched } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
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
    const { result } = await runPrs({
      snapshots: { acme: prSnapshot([repoRow("widgets")], []) },
    });
    expect(result.stats.source).toBe("db");
  });

  test("returns a pull request once even when two routes yield it in different spellings", async () => {
    const world = prWorld([target]);
    const { result } = await runPrs(
      {
        ...world,
        snapshots: {
          acme: world.snapshots?.acme ?? new Error("missing"),
          beta: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
        searches: {
          beta: [prSearchItem(3, { owner: "acme", repo: "widgets" })],
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(result.items.map((item) => item.number)).toEqual([3]);
  });

  test("processes the candidates one by one and reads two requests at a time at most", async () => {
    const second = prCase(4, { labels: [REVIEW_LABEL] });
    const world = prWorld([target, second]);
    let inFlight = 0;
    let maxInFlight = 0;
    const tracked = async <T>(read: () => T): Promise<T> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return read();
    };
    const prOf = (number: number): PullRequest => {
      const found = world.prs?.[`acme/widgets#${String(number)}`];
      if (found === undefined || found instanceof Error) throw new Error("x");
      return found;
    };
    const issueOf = (number: number): Issue => {
      const found = world.issues?.[`acme/widgets#${String(number)}`];
      if (found === undefined || found instanceof Error) throw new Error("x");
      return found;
    };
    await runPrs(world, {
      rest: {
        getPr: (_owner, _repo, number) => tracked(() => prOf(number)),
        getIssue: (_owner, _repo, number) => tracked(() => issueOf(number)),
      },
    });
    expect(maxInFlight).toBe(2);
  });
});

describe("the table and the search find the same pull requests", () => {
  const POLICY: LabelerPolicy = {
    viewerLogin: VIEWER.login,
    allowedLogins: ["admin", "alice"],
    allowedIds: {},
  };

  function candidateOf(found: PrCase): PrCandidate {
    const labels = found.asIssue.labels;
    return {
      owner: found.item.owner,
      repo: found.item.repo,
      number: found.item.number,
      title: found.pr.title,
      headSha: found.pr.headSha,
      headRef: found.pr.headRef,
      labels,
      authorLogin: found.pr.authorLogin,
      authorId: found.pr.authorId,
      headInBaseRepo: found.pr.headRepoFullName === found.pr.baseRepoFullName,
      reviewLabelerLogin: labels.includes(REVIEW_LABEL) ? "admin" : null,
      fixLabelerLogin: labels.includes(FIX_LABEL) ? "admin" : null,
      hasActiveReviewingItem: false,
      activeFixItemId: null,
      lastKnownHeadSha: null,
      previousFixRound: 0,
      maxReviewId: 0,
    };
  }

  /** 検索の経路と表の経路の項目を、許可リストを当ててから返す。 */
  async function both(
    fixture: PrFixture,
    options: PrOptions = {},
  ): Promise<{ search: PrSearchItem[]; table: PrSearchItem[] }> {
    const owners = options.owners ?? [ACME];
    const scope = scopeOf(owners, options.repoAllowlist ?? []);
    const search = await runPrs(fixture, { ...options, source: "search" });
    const table = await runPrs(fixture, { ...options, source: "db" });
    return {
      search: filterByRepoAllowlist(search.result.items, scope),
      table: filterByRepoAllowlist(table.result.items, scope),
    };
  }

  /** 項目ごとの判定を、番号の順に並べて返す。 */
  function decisionsOf(
    items: readonly PrSearchItem[],
    cases: readonly PrCase[],
  ) {
    const candidates = items
      .map((item) => cases.find((found) => found.item.number === item.number))
      .filter((found): found is PrCase => found !== undefined)
      .map(candidateOf);
    return decidePrActions(candidates, REVIEW_LABEL, FIX_LABEL, POLICY)
      .map((decision) => ({
        number: decision.candidate.number,
        review: decision.review,
        fix: decision.fix,
      }))
      .sort((a, b) => a.number - b.number);
  }

  const mixed = [
    prCase(1, { labels: [REVIEW_LABEL] }),
    prCase(2, { labels: [FIX_LABEL] }),
    prCase(3, { requestsViewer: true }),
    prCase(4, { assignedToViewer: true }),
    prCase(5),
  ];

  test("returns the same items for labels, direct requests, assignees and others", async () => {
    const { search, table } = await both(prWorld(mixed));
    expect(table).toEqual(search);
  });

  test("makes the same decisions for labels, direct requests, assignees and others", async () => {
    const { search, table } = await both(prWorld(mixed));
    expect(decisionsOf(table, mixed)).toEqual(decisionsOf(search, mixed));
  });

  const hostile = [
    prCase(1, { labels: [REVIEW_LABEL], fork: true }),
    prCase(2, { assignedToViewer: true, draft: true }),
    prCase(3, { assignedToViewer: true, author: "mallory" }),
    prCase(4, { labels: [FIX_LABEL], author: "mallory" }),
  ];

  test("makes the same decisions for forks, drafts and authors that are not allowed", async () => {
    const { search, table } = await both(prWorld(hostile));
    expect(decisionsOf(table, hostile)).toEqual(decisionsOf(search, hostile));
  });

  test("refuses the review of a fork head in both routes", async () => {
    const { table } = await both(prWorld(hostile));
    expect(
      decisionsOf(table, hostile).find((decision) => decision.number === 1)
        ?.review.kind,
    ).toBe("deny_fork_head");
  });

  const withStaleRows = [
    prCase(1, { labels: [REVIEW_LABEL] }),
    prCase(2, { labels: [REVIEW_LABEL], staleRow: true }),
    prCase(3, { assignedToViewer: true, staleRow: true }),
    prCase(4, { labels: [FIX_LABEL], closed: true }),
  ];

  test("drops stale rows by REST and agrees with a fresh search index", async () => {
    const { search, table } = await both(prWorld(withStaleRows));
    expect(table).toEqual(search);
  });

  test("leaves a dropped candidate to the tracked pull requests, as the search does", async () => {
    const { table } = await both(prWorld(withStaleRows));
    expect(table.map((item) => item.number)).toEqual([1]);
  });

  test("gives the work item the spelling of the search", async () => {
    const { table } = await both(prWorld([prCase(1, { labels: [FIX_LABEL] })]));
    expect(
      table.map((item) => `${item.owner}/${item.repo}#${String(item.number)}`),
    ).toEqual(["Acme/Widgets#1"]);
  });

  test("agrees when the set includes a repository that is not allowed", async () => {
    const found = prCase(3, { labels: [REVIEW_LABEL] });
    const stray = prCase(9, { labels: [REVIEW_LABEL] });
    const world = prWorld([found]);
    const { search, table } = await both(
      {
        ...world,
        searches: {
          acme: [found.item, prSearchItem(9, { repo: "Gadgets" })],
        },
        snapshots: {
          acme: prSnapshot(
            [repoRow("widgets"), repoRow("gadgets")],
            [found.row, { ...stray.row, repo: "gadgets" }],
          ),
        },
        prs: { ...world.prs, "acme/gadgets#9": stray.pr },
        issues: {
          ...world.issues,
          "acme/gadgets#9": {
            ...stray.asIssue,
            repository: { owner: "Acme", repo: "Gadgets" },
          },
        },
      },
      { repoAllowlist: ["https://github.com/acme/widgets"] },
    );
    expect(table).toEqual(search);
  });

  test("goes back to the search for an owner with a team request and agrees", async () => {
    const withTeam = [
      prCase(1, { labels: [REVIEW_LABEL] }),
      prCase(2, { team: true }),
    ];
    const { search, table } = await both(prWorld(withTeam));
    expect(table).toEqual(search);
  });

  test("agrees across owners that read the table and owners that go back to the search", async () => {
    const found = prCase(1, { labels: [REVIEW_LABEL] });
    const world = prWorld([found]);
    const betaItem = prSearchItem(7, {
      owner: "Beta",
      repo: "Tools",
      htmlUrl: "https://github.com/Beta/Tools/pull/7",
    });
    const { search, table } = await both(
      {
        ...world,
        searches: { acme: [found.item], beta: [betaItem] },
        snapshots: {
          acme: world.snapshots?.acme ?? new Error("missing"),
          beta: prSnapshot(
            [repoRow("tools", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      { owners: [ACME, BETA] },
    );
    // 表の候補は検索の結果の後に並ぶので、並びは比べない。
    const byNumber = (a: PrSearchItem, b: PrSearchItem) => a.number - b.number;
    expect([...table].sort(byNumber)).toEqual([...search].sort(byNumber));
  });
});

describe("the differences of the pull requests that are accepted", () => {
  test("a new request that is not in the table yet is found by the search only", async () => {
    const known = prCase(3, { labels: [REVIEW_LABEL] });
    const fresh = prCase(9, { requestsViewer: true });
    const world = prWorld([known]);
    const fixture = {
      ...world,
      searches: { acme: [known.item, fresh.item] },
    };
    const search = await runPrs(fixture, { source: "search" });
    const table = await runPrs(fixture, { source: "db" });
    expect([
      search.result.items.map((item) => item.number),
      table.result.items.map((item) => item.number),
    ]).toEqual([[3, 9], [3]]);
  });
});

describe("the round of the pull requests does not stop when the table cannot be used", () => {
  const sameAsSearch = async (fixture: PrFixture, options: PrOptions = {}) => {
    const search = await runPrs(fixture, { ...options, source: "search" });
    const table = await runPrs(fixture, { ...options, source: "db" });
    return { search: search.result.items, table: table.result.items };
  };

  test("finds the pull requests by the search when every owner is too old", async () => {
    const { search, table } = await sameAsSearch(
      {
        searches: { acme: [prSearchItem(3)], beta: [prSearchItem(8)] },
        snapshots: {
          acme: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(table).toEqual(search);
  });

  test("finds the pull requests by the search when every read fails", async () => {
    const { search, table } = await sameAsSearch(
      {
        searches: { acme: [prSearchItem(3)], beta: [prSearchItem(8)] },
        snapshots: { acme: new Error("down"), beta: new Error("down") },
      },
      { owners: [ACME, BETA] },
    );
    expect(table).toEqual(search);
  });
});
