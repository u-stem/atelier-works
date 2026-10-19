// `poll_issues`と`poll_prs`が、トリガーのIssueとPRを見つける経路のテスト。
// 表の候補をRESTで確かめ直すこと、古い非明示のリポジトリを見送ること、明示のリポジトリを表が使えないときだけRESTで読むことを確かめる。

import { describe, expect, test } from "bun:test";
import {
  getIssue,
  getPr,
  type Issue,
  type IssueSearchItem,
  listLabeledOpenIssues,
  listOpenPullRequests,
  type OpenPullRequest,
  type PrSearchItem,
  type PullRequest,
  type Viewer,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  classifyPollPrRow,
  confirmIssueCandidate,
  confirmPrCandidate,
  discoverIssues,
  discoverPrs,
  issueKey,
  resolveTableUse,
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
import { ghApiOk } from "./testSupport.ts";

const MINUTE_MS = 60_000;
const DB_NOW = new Date("2026-10-18T00:00:00.000Z");
const STALE_AFTER_MS = 15 * MINUTE_MS;
const TOO_OLD = new Date(DB_NOW.getTime() - STALE_AFTER_MS - 1);
const IN_FUTURE = new Date(DB_NOW.getTime() + MINUTE_MS);
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
    isPullRequest: false,
    ...overrides,
  };
}

/** 候補の項目。綴りは`getIssue`の応答と同じ。 */
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

/** 所有者`acme`の`gadgets`の応答。 */
function gadgetsIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return restIssue(number, {
    htmlUrl: `https://github.com/Acme/Gadgets/issues/${String(number)}`,
    repository: { owner: "Acme", repo: "Gadgets" },
    ...overrides,
  });
}

/** 明示のどのリポジトリにも当たらない`factory_repo`。所有者の他のリポジトリがすべて非明示になる。 */
const OUTSIDE_FACTORY = "https://github.com/outside/factory";

type Fixture = {
  /** 所有者名(小文字)ごとの表の読み取り。`Error`なら失敗する。 */
  snapshots?: Record<string, GhOwnerOpenIssueSnapshot | Error>;
  /** `owner/repo`(小文字)ごとの、トリガーラベル付きのIssueの一覧。`Error`なら失敗する。 */
  listings?: Record<string, number[] | Error>;
  /** `owner/repo#number`(小文字)ごとの`getIssue`の応答。 */
  issues?: Record<string, Issue | Error>;
};

type Options = {
  useTable?: boolean;
  owners?: readonly FactoryOwner[];
  repoAllowlist?: string[];
  factoryRepo?: string;
  staleAfterMs?: number;
};

function scopeOf(
  owners: readonly FactoryOwner[],
  repoAllowlist: string[],
  factoryRepo = "https://github.com/acme/widgets",
) {
  return {
    owners: [...owners],
    repo_allowlist: repoAllowlist,
    factory_repo: factoryRepo,
  };
}

async function run(fixture: Fixture, options: Options = {}) {
  const owners = options.owners ?? [ACME];
  const read: string[] = [];
  const listed: string[] = [];
  const labels: string[] = [];
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
      useTable: options.useTable ?? true,
      owners,
      scope: scopeOf(owners, options.repoAllowlist ?? [], options.factoryRepo),
      triggerLabel: LABEL,
      staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS,
      log,
    },
    {
      readOwnerIssues: async (owner) => {
        read.push(owner);
        const found = fixture.snapshots?.[owner.toLowerCase()];
        if (found === undefined) throw new Error("no snapshot");
        if (found instanceof Error) throw found;
        return found;
      },
      listLabeledIssues: async (owner, repo, label) => {
        listed.push(`${owner}/${repo}`);
        labels.push(label);
        const found = fixture.listings?.[`${owner}/${repo}`.toLowerCase()];
        if (found === undefined) throw new Error("no listing");
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
  return { result, read, listed, labels, got, failures, logs };
}

/** 鮮度の足りるwidgetsの表に、指定の番号の行がある所有者。 */
function freshAcme(...numbers: number[]): GhOwnerOpenIssueSnapshot {
  return snapshot(
    [repoRow("widgets")],
    numbers.map((number) => tableRow({ id: number, number })),
  );
}

/** 表が使えない理由と、それを起こす`gh_repos`の行の上書き。 */
const STALE_CASES: readonly {
  readonly reason: string;
  readonly overrides: Partial<GhOwnerRepoFreshnessRow>;
}[] = [
  { reason: "too_old", overrides: { last_collected_at: TOO_OLD } },
  { reason: "not_collected", overrides: { last_collected_at: null } },
  { reason: "in_future", overrides: { last_collected_at: IN_FUTURE } },
  { reason: "unusable", overrides: { repo_id: null } },
];

describe("resolveTableUse", () => {
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

  test("reads the table when the collection and its detail are on", () => {
    const { log } = capture();
    expect(
      resolveTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(true);
  });

  test("does not read the table when the collection is off", () => {
    const { log } = capture();
    expect(
      resolveTableUse(
        { gh_collect_enabled: false, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(false);
  });

  test("does not read the table when the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolveTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: false },
        log,
      ),
    ).toBe(false);
  });

  test("warns with the names of the false settings when the table is not read", () => {
    const { log, warnings } = capture();
    resolveTableUse(
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
    resolveTableUse(
      { gh_collect_enabled: true, gh_collect_detail_enabled: true },
      log,
    );
    expect(warnings).toEqual([]);
  });
});

describe("issueKey", () => {
  test("lowercases the owner and the repository", () => {
    expect(issueKey("Acme", "Widgets", 3)).toBe("acme/widgets#3");
  });
});

describe("confirmIssueCandidate", () => {
  test("accepts an open issue with the trigger label and builds the item from the REST values", () => {
    const check = confirmIssueCandidate(tableRow(), restIssue(3), LABEL);
    expect(check).toEqual({ kind: "ok", item: searchItem(3) });
  });

  test("compares the trigger label without regard to case", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { labels: ["Factory"] }),
      LABEL,
    );
    expect(check.kind).toBe("ok");
  });

  test("drops a closed issue", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { state: "closed" }),
      LABEL,
    );
    expect(check).toEqual({ kind: "drop", reason: "closed" });
  });

  test("drops an issue whose trigger label is gone", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { labels: ["bug"] }),
      LABEL,
    );
    expect(check).toEqual({ kind: "drop", reason: "label_absent" });
  });

  test("drops a pull request", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { isPullRequest: true }),
      LABEL,
    );
    expect(check).toEqual({ kind: "drop", reason: "pull_request" });
  });

  test("reports a mismatch when the repository is unknown", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { repository: null }),
      LABEL,
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the repository differs from the row in lowercase", () => {
    const check = confirmIssueCandidate(
      tableRow(),
      restIssue(3, { repository: { owner: "Acme", repo: "Gadgets" } }),
      LABEL,
    );
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("reports a mismatch when the number differs from the row", () => {
    const check = confirmIssueCandidate(tableRow(), restIssue(4), LABEL);
    expect(check).toEqual({ kind: "mismatch" });
  });

  test("accepts a reference that is only an owner, a repository and a number", () => {
    const check = confirmIssueCandidate(
      { owner: "acme", repo: "widgets", number: 3 },
      restIssue(3),
      LABEL,
    );
    expect(check.kind).toBe("ok");
  });
});

describe("discoverIssues from the table", () => {
  test("does not list the explicit repository when its record is fresh", async () => {
    const { listed } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3) },
    });
    expect(listed).toEqual([]);
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

  test("reads the table of each owner once", async () => {
    const { read } = await run(
      {
        snapshots: {
          acme: freshAcme(),
          beta: snapshot([repoRow("tools")], []),
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(read).toEqual(["Acme", "Beta"]);
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

  test("counts the confirmed candidates", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3, 4) },
      issues: {
        "acme/widgets#3": restIssue(3, { labels: [] }),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect(result.stats.candidates).toBe(2);
  });

  test("counts the dropped candidates", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3, 4) },
      issues: {
        "acme/widgets#3": restIssue(3, { labels: [] }),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect(result.stats.dropped).toBe(1);
  });

  test("drops a row that GitHub reports as a pull request", async () => {
    const { result } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3, { isPullRequest: true }) },
    });
    expect(result.items).toEqual([]);
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
    ]).toEqual([["confirm_issue:acme/widgets#3"], [4], 1]);
  });

  test("records a mismatch as a failure and drops the candidate", async () => {
    const { result, failures } = await run({
      snapshots: { acme: freshAcme(3) },
      issues: { "acme/widgets#3": restIssue(3, { repository: null }) },
    });
    expect([failures, result.items]).toEqual([
      ["confirm_issue:acme/widgets#3"],
      [],
    ]);
  });

  test("judges the freshness with the given threshold", async () => {
    const { listed } = await run(
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
    expect(listed).toEqual([]);
  });
});

describe("discoverIssues skips a stale repository that is not explicit", () => {
  const options: Options = { factoryRepo: OUTSIDE_FACTORY };

  /** gadgetsが古く、toolsが新しい所有者。 */
  function mixed(overrides: Partial<GhOwnerRepoFreshnessRow>) {
    return {
      snapshots: {
        acme: snapshot(
          [repoRow("gadgets", overrides), repoRow("tools")],
          [
            tableRow({ id: 9, repo: "gadgets", number: 9 }),
            tableRow({ id: 7, repo: "tools", number: 7 }),
          ],
        ),
      },
      issues: {
        "acme/gadgets#9": gadgetsIssue(9),
        "acme/tools#7": restIssue(7, {
          htmlUrl: "https://github.com/Acme/Tools/issues/7",
          repository: { owner: "Acme", repo: "Tools" },
        }),
      },
    };
  }

  for (const { reason, overrides } of STALE_CASES) {
    test(`counts the repository by the reason ${reason}`, async () => {
      const { result } = await run(mixed(overrides), options);
      expect(result.stats.skipped_stale_reasons).toEqual({ [reason]: 1 });
    });
  }

  test("counts the skipped repositories", async () => {
    const { result } = await run(
      mixed({ last_collected_at: TOO_OLD }),
      options,
    );
    expect(result.stats.skipped_stale).toBe(1);
  });

  test("takes the rows of a fresh repository next to a stale one", async () => {
    const { result } = await run(
      mixed({ last_collected_at: TOO_OLD }),
      options,
    );
    expect(result.items.map((item) => item.repo)).toEqual(["Tools"]);
  });

  test("does not read the issues of a stale repository", async () => {
    const { got } = await run(mixed({ last_collected_at: TOO_OLD }), options);
    expect(got).toEqual(["acme/tools#7"]);
  });

  test("does not list a stale repository by REST", async () => {
    const { listed } = await run(
      mixed({ last_collected_at: TOO_OLD }),
      options,
    );
    expect(listed).toEqual([]);
  });

  test("does not record a failure for a skipped repository", async () => {
    const { failures } = await run(
      mixed({ last_collected_at: TOO_OLD }),
      options,
    );
    expect(failures).toEqual([]);
  });

  test("counts nothing when every repository is fresh", async () => {
    const { result } = await run(mixed({}), options);
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("counts both repositories when both are stale", async () => {
    const { result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
              repoRow("tools", { last_collected_at: null }),
            ],
            [],
          ),
        },
      },
      options,
    );
    expect(result.stats.skipped_stale_reasons).toEqual({
      too_old: 1,
      not_collected: 1,
    });
  });

  test("does not count an archived repository", async () => {
    const { result } = await run(
      mixed({ archived: true, last_collected_at: TOO_OLD }),
      options,
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("does not count a repository that is gone", async () => {
    const { result } = await run(
      mixed({ gone: true, last_collected_at: TOO_OLD }),
      options,
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("does not count a repository that is not allowed now", async () => {
    const { result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("gadgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      {
        factoryRepo: OUTSIDE_FACTORY,
        repoAllowlist: ["https://github.com/acme/widgets"],
      },
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("builds new reason records for every round", async () => {
    const fixture = mixed({ last_collected_at: TOO_OLD });
    const first = await run(fixture, options);
    const second = await run(fixture, options);
    expect(first.result.stats.skipped_stale_reasons).not.toBe(
      second.result.stats.skipped_stale_reasons,
    );
  });
});

describe("discoverIssues reads an explicit repository by REST when the table cannot be used", () => {
  const OPEN_LISTING = { "acme/widgets": [3] };
  const WIDGETS_ISSUE = { "acme/widgets#3": restIssue(3) };

  function staleWidgets(overrides: Partial<GhOwnerRepoFreshnessRow>) {
    return {
      snapshots: {
        acme: snapshot([repoRow("widgets", overrides)], []),
      },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    };
  }

  for (const { reason, overrides } of STALE_CASES) {
    test(`lists the repository by REST for the reason ${reason}`, async () => {
      const { listed } = await run(staleWidgets(overrides));
      expect(listed).toEqual(["acme/widgets"]);
    });

    test(`reports the reason ${reason}`, async () => {
      const { result } = await run(staleWidgets(overrides));
      expect(result.stats.rest_reasons).toEqual({ [reason]: 1 });
    });
  }

  test("returns the confirmed candidates of the list in the spelling of GitHub", async () => {
    const { result } = await run(staleWidgets({ last_collected_at: TOO_OLD }));
    expect(result.items).toEqual([searchItem(3)]);
  });

  test("asks for the issues with the trigger label", async () => {
    const { labels } = await run(staleWidgets({ last_collected_at: TOO_OLD }));
    expect(labels).toEqual([LABEL]);
  });

  test("lists the repository when it has no gh_repos row", async () => {
    const { listed } = await run({
      snapshots: { acme: snapshot([repoRow("tools")], []) },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    });
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reports no_record when the repository has no gh_repos row", async () => {
    const { result } = await run({
      snapshots: { acme: snapshot([], []) },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    });
    expect(result.stats.rest_reasons).toEqual({ no_record: 1 });
  });

  test("lists the repository when it is gone", async () => {
    const { listed } = await run(staleWidgets({ gone: true }));
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("records a failure when the list of a gone repository is not found", async () => {
    const { failures } = await run({
      ...staleWidgets({ gone: true }),
      listings: { "acme/widgets": new Error("HTTP 404") },
    });
    expect(failures).toEqual(["list_labeled_issues:acme/widgets"]);
  });

  test("does not list an archived repository whose record is fresh", async () => {
    const { listed } = await run(staleWidgets({ archived: true }));
    expect(listed).toEqual([]);
  });

  test("does not count an archived repository whose record is fresh", async () => {
    const { result } = await run(staleWidgets({ archived: true }));
    expect(result.stats.rest_lists).toBe(0);
  });

  test("lists an archived repository whose record is too old", async () => {
    const { listed } = await run(
      staleWidgets({ archived: true, last_collected_at: TOO_OLD }),
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("lists an archived repository whose record was never collected", async () => {
    const { listed } = await run(
      staleWidgets({ archived: true, last_collected_at: null }),
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reads a number once when the pages of the list overlap", async () => {
    const { got } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      listings: { "acme/widgets": [3, 3] },
    });
    expect(got).toEqual(["acme/widgets#3"]);
  });

  test("returns an issue once when the pages of the list overlap", async () => {
    const { result } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      listings: { "acme/widgets": [3, 3] },
    });
    expect(result.items).toEqual([searchItem(3)]);
  });

  test("counts the repositories read by REST", async () => {
    const { result } = await run(staleWidgets({ last_collected_at: TOO_OLD }));
    expect(result.stats.rest_lists).toBe(1);
  });

  test("lists every explicit repository of the allowlist that is stale", async () => {
    const { listed } = await run(
      {
        snapshots: {
          acme: snapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [],
          ),
        },
        listings: { "acme/widgets": [], "acme/gadgets": [] },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(listed).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  test("lists only the stale one when another explicit repository is fresh", async () => {
    const { listed } = await run(
      {
        snapshots: {
          acme: snapshot(
            [
              repoRow("widgets"),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [tableRow({ number: 3 })],
          ),
        },
        listings: { "acme/gadgets": [] },
        issues: WIDGETS_ISSUE,
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(listed).toEqual(["acme/gadgets"]);
  });

  test("returns the table candidates before the listed ones", async () => {
    const { result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [
              repoRow("widgets"),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [tableRow({ number: 3 })],
          ),
        },
        listings: { "acme/gadgets": [8] },
        issues: { ...WIDGETS_ISSUE, "acme/gadgets#8": gadgetsIssue(8) },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(
      result.items.map((item) => `${item.repo}#${String(item.number)}`),
    ).toEqual(["Widgets#3", "Gadgets#8"]);
  });

  test("does not list an explicit repository of an owner that is not verified", async () => {
    const { listed } = await run(
      {
        snapshots: { beta: snapshot([], []) },
        listings: OPEN_LISTING,
        issues: WIDGETS_ISSUE,
      },
      { owners: [BETA] },
    );
    expect(listed).toEqual([]);
  });

  test("lists an explicit repository under its own owner only", async () => {
    const { listed } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: snapshot([], []),
        },
        listings: OPEN_LISTING,
        issues: WIDGETS_ISSUE,
      },
      {
        owners: [ACME, BETA],
        repoAllowlist: ["https://github.com/acme/widgets"],
      },
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("lists the repository and records a failure when the table cannot be read", async () => {
    const { listed, failures } = await run({
      snapshots: { acme: new Error("db down") },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    });
    expect([listed, failures]).toEqual([
      ["acme/widgets"],
      ["read_gh_owner_issues:Acme"],
    ]);
  });

  test("counts a failed read of the table as a failure of the round", async () => {
    const { result } = await run({
      snapshots: { acme: new Error("db down") },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    });
    expect(result.failed).toBe(1);
  });

  test("reports read_failed when the table cannot be read", async () => {
    const { result } = await run({
      snapshots: { acme: new Error("db down") },
      listings: OPEN_LISTING,
      issues: WIDGETS_ISSUE,
    });
    expect(result.stats.rest_reasons).toEqual({ read_failed: 1 });
  });

  test("does not read the table when the collection is off", async () => {
    const { read } = await run(
      { listings: OPEN_LISTING, issues: WIDGETS_ISSUE },
      { useTable: false },
    );
    expect(read).toEqual([]);
  });

  test("lists the explicit repository when the collection is off", async () => {
    const { listed } = await run(
      { listings: OPEN_LISTING, issues: WIDGETS_ISSUE },
      { useTable: false },
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reports collect_disabled when the collection is off", async () => {
    const { result } = await run(
      { listings: OPEN_LISTING, issues: WIDGETS_ISSUE },
      { useTable: false },
    );
    expect(result.stats.rest_reasons).toEqual({ collect_disabled: 1 });
  });

  test("records no failure when the collection is off", async () => {
    const { failures } = await run(
      { listings: OPEN_LISTING, issues: WIDGETS_ISSUE },
      { useTable: false },
    );
    expect(failures).toEqual([]);
  });

  test("records a failed list and goes on to the next repository", async () => {
    const { failures, result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [],
          ),
        },
        listings: { "acme/widgets": new Error("boom"), "acme/gadgets": [8] },
        issues: { "acme/gadgets#8": gadgetsIssue(8) },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect([failures, result.items.map((item) => item.number)]).toEqual([
      ["list_labeled_issues:acme/widgets"],
      [8],
    ]);
  });

  test("counts a failed list as a failure of the round", async () => {
    const { result } = await run({
      snapshots: {
        acme: snapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
      listings: { "acme/widgets": new Error("boom") },
    });
    expect(result.failed).toBe(1);
  });

  test("goes on to the next owner after a failed list", async () => {
    const { result } = await run(
      {
        snapshots: {
          acme: snapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: snapshot(
            [repoRow("tools")],
            [tableRow({ id: 7, owner: "beta", repo: "tools", number: 7 })],
          ),
        },
        listings: { "acme/widgets": new Error("boom") },
        issues: {
          "beta/tools#7": restIssue(7, {
            repository: { owner: "Beta", repo: "Tools" },
          }),
        },
      },
      {
        owners: [ACME, BETA],
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/beta/tools",
        ],
      },
    );
    expect(result.items.map((item) => item.number)).toEqual([7]);
  });

  test("drops a listed issue that has been closed since", async () => {
    const { result } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      issues: { "acme/widgets#3": restIssue(3, { state: "closed" }) },
    });
    expect(result.items).toEqual([]);
  });

  test("drops a listed number that GitHub reports as a pull request", async () => {
    const { result } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      issues: { "acme/widgets#3": restIssue(3, { isPullRequest: true }) },
    });
    expect(result.items).toEqual([]);
  });

  test("records no failure for a dropped pull request", async () => {
    const { failures } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      issues: { "acme/widgets#3": restIssue(3, { isPullRequest: true }) },
    });
    expect(failures).toEqual([]);
  });

  test("counts a listed candidate that is dropped", async () => {
    const { result } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      issues: { "acme/widgets#3": restIssue(3, { labels: [] }) },
    });
    expect([result.stats.candidates, result.stats.dropped]).toEqual([1, 1]);
  });

  test("records a mismatch of a listed issue as a failure", async () => {
    const { failures } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      issues: { "acme/widgets#3": restIssue(3, { repository: null }) },
    });
    expect(failures).toEqual(["confirm_issue:acme/widgets#3"]);
  });

  test("records a failed read of a listed issue and drops only that candidate", async () => {
    const { result, failures } = await run({
      ...staleWidgets({ last_collected_at: TOO_OLD }),
      listings: { "acme/widgets": [3, 4] },
      issues: {
        "acme/widgets#3": new Error("boom"),
        "acme/widgets#4": restIssue(4),
      },
    });
    expect([failures, result.items.map((item) => item.number)]).toEqual([
      ["confirm_issue:acme/widgets#3"],
      [4],
    ]);
  });

  test("builds new reason records for every round", async () => {
    const fixture = staleWidgets({ last_collected_at: TOO_OLD });
    const first = await run(fixture);
    const second = await run(fixture);
    expect(first.result.stats.rest_reasons).not.toBe(
      second.result.stats.rest_reasons,
    );
  });
});

describe("the table and the list find the same issues", () => {
  const WORLD = {
    listings: { "acme/widgets": [3, 4] },
    issues: {
      "acme/widgets#3": restIssue(3),
      "acme/widgets#4": restIssue(4),
    },
  };

  async function both() {
    const table = await run({
      ...WORLD,
      snapshots: { acme: freshAcme(3, 4) },
    });
    const listed = await run({
      ...WORLD,
      snapshots: {
        acme: snapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    });
    return { table: table.result.items, listed: listed.result.items };
  }

  test("returns the same items for open issues with the trigger label", async () => {
    const { table, listed } = await both();
    expect(listed).toEqual(table);
  });

  test("gives the work item the spelling of GitHub", async () => {
    const { listed } = await both();
    expect(listed.map((item) => `${item.owner}/${item.repo}`)).toEqual([
      "Acme/Widgets",
      "Acme/Widgets",
    ]);
  });

  test("passes the same repository gate as the table", async () => {
    const { listed } = await both();
    const scope = scopeOf([ACME], []);
    expect(filterByRepoAllowlist(listed, scope)).toEqual(listed);
  });
});

describe("discoverIssues never calls a search endpoint", () => {
  /** 実際の`listLabeledOpenIssues`と`getIssue`を、呼ばれたendpointを記録する偽の`gh`に通す。 */
  async function discoverWithRealReaders(options: Options) {
    const endpoints: string[] = [];
    const client = {
      ghToken: "tok",
      run: async (argv: readonly string[]) => {
        const endpoint =
          argv.find(
            (arg) => arg.startsWith("repos/") || arg.startsWith("search/"),
          ) ?? "";
        endpoints.push(endpoint);
        if (endpoint.includes("/issues?labels=")) {
          return ghApiOk([
            { number: 3, title: "t", html_url: "u", state: "open" },
            {
              number: 4,
              title: "t",
              html_url: "u",
              state: "open",
              pull_request: {},
            },
          ]);
        }
        return ghApiOk({
          number: 3,
          title: "title 3",
          body: "body 3",
          html_url: "https://github.com/Acme/Widgets/issues/3",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: LABEL }],
          assignees: [],
          repository_url: "https://api.github.com/repos/Acme/Widgets",
        });
      },
    };
    const owners = options.owners ?? [ACME];
    const log: Logger = { info() {}, warn() {}, error() {} };
    const result = await discoverIssues(
      {
        useTable: options.useTable ?? true,
        owners,
        scope: scopeOf(owners, []),
        triggerLabel: LABEL,
        staleAfterMs: STALE_AFTER_MS,
        log,
      },
      {
        readOwnerIssues: async () =>
          snapshot([repoRow("widgets", { last_collected_at: TOO_OLD })], []),
        listLabeledIssues: (owner, repo, label) =>
          listLabeledOpenIssues(client, owner, repo, label),
        getIssue: (owner, repo, number) =>
          getIssue(client, owner, repo, number),
        recordFailure: async () => {},
      },
    );
    return { result, endpoints };
  }

  test("reads the explicit repository through the issues endpoint only", async () => {
    const { endpoints } = await discoverWithRealReaders({});
    expect(endpoints.filter((endpoint) => endpoint.includes("search"))).toEqual(
      [],
    );
  });

  test("finds the labeled issue and leaves the pull request out", async () => {
    const { result } = await discoverWithRealReaders({});
    expect(result.items.map((item) => item.number)).toEqual([3]);
  });

  test("does not call a search endpoint when the collection is off", async () => {
    const { endpoints } = await discoverWithRealReaders({ useTable: false });
    expect(endpoints.filter((endpoint) => endpoint.includes("search"))).toEqual(
      [],
    );
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

describe("confirmPrCandidate", () => {
  const row = prRow({ number: 3 });
  const confirm = (
    pr: PullRequest,
    asIssue: Issue,
  ): ReturnType<typeof confirmPrCandidate> =>
    confirmPrCandidate(row, pr, asIssue, VIEWER, PR_LABELS);

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

/** 候補の項目。綴りは`getPr`の応答と同じ。 */
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
  /** 所有者名(小文字)ごとの表の読み取り。`Error`なら失敗する。 */
  snapshots?: Record<string, GhOwnerOpenPrSnapshot | Error>;
  /** `owner/repo`(小文字)ごとの、開いているPRの一覧。`Error`なら失敗する。 */
  listings?: Record<string, OpenPullRequest[] | Error>;
  /** `owner/repo#number`(小文字)ごとの`getPr`の応答。 */
  prs?: Record<string, PullRequest | Error>;
  /** `owner/repo#number`(小文字)ごとの、PRを`getIssue`で読んだ応答。 */
  issues?: Record<string, Issue | Error>;
};

type PrOptions = {
  useTable?: boolean;
  owners?: readonly FactoryOwner[];
  repoAllowlist?: string[];
  factoryRepo?: string;
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

/** 明示のどのリポジトリにも当たらない設定。所有者のリポジトリがすべて非明示になる。 */
const NOT_EXPLICIT: PrOptions = { factoryRepo: OUTSIDE_FACTORY };

async function runPrs(fixture: PrFixture, options: PrOptions = {}) {
  const owners = options.owners ?? [ACME];
  const read: string[] = [];
  const listed: string[] = [];
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
      useTable: options.useTable ?? true,
      owners,
      scope: scopeOf(owners, options.repoAllowlist ?? [], options.factoryRepo),
      viewer: VIEWER,
      labels: PR_LABELS,
      staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS,
      log,
    },
    {
      readOwnerPrs: async (owner) => {
        read.push(owner);
        const found = fixture.snapshots?.[owner.toLowerCase()];
        if (found === undefined) throw new Error("no snapshot");
        if (found instanceof Error) throw found;
        return found;
      },
      listOpenPrs: async (owner, repo) => {
        listed.push(`${owner}/${repo}`);
        const found = fixture.listings?.[`${owner}/${repo}`.toLowerCase()];
        if (found === undefined) throw new Error("no listing");
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
  return { result, read, listed, gotPr, gotIssue, failures, logs };
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
  /** 表の行と一覧は対象と言うが、RESTでは対象でなくなっている。 */
  staleRow?: boolean;
};

/** 表の行、一覧の要素、RESTの応答を、同じPRについて整合させて作る。 */
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
  const listed: OpenPullRequest = {
    number,
    draft: options.draft ?? false,
    headRef: "feature",
    headRepoFullName: options.fork ? "forker/Widgets" : "Acme/Widgets",
    baseRepoFullName: "Acme/Widgets",
    authorLogin: options.author ?? "alice",
    authorId: 1001,
    baseRef: "main",
    createdAtMs: Date.parse("2026-10-10T00:00:00.000Z"),
    labels,
    assigneeIds: options.assignedToViewer ? [VIEWER_ID] : [],
    requestedReviewerIds: options.requestsViewer ? [VIEWER_ID] : [OTHER_ID],
    teamReviewRequested: options.team ?? false,
  };
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
  return { row, listed, pr, asIssue, item: prSearchItem(number) };
}

type PrCase = ReturnType<typeof prCase>;

function restFixtures(cases: readonly PrCase[], repo = "widgets") {
  const prs: Record<string, PullRequest> = {};
  const issues: Record<string, Issue> = {};
  for (const found of cases) {
    const key = `acme/${repo}#${String(found.item.number)}`;
    prs[key] = found.pr;
    issues[key] = found.asIssue;
  }
  return { prs, issues };
}

/** 所有者`acme`の`widgets`の記録が新しく、表の行と一覧とRESTが同じPRの集合を言う。 */
function prWorld(cases: readonly PrCase[]): PrFixture {
  return {
    snapshots: {
      acme: prSnapshot(
        [repoRow("widgets")],
        cases.map((found) => found.row),
      ),
    },
    listings: { "acme/widgets": cases.map((found) => found.listed) },
    ...restFixtures(cases),
  };
}

/** `prWorld`と同じ集合で、`widgets`の記録だけが古い。表の行は使えず、一覧とRESTだけが答える。 */
function staleWorld(
  cases: readonly PrCase[],
  overrides: Partial<GhOwnerRepoFreshnessRow> = { last_collected_at: TOO_OLD },
): PrFixture {
  return {
    ...prWorld(cases),
    snapshots: {
      acme: prSnapshot(
        [repoRow("widgets", overrides)],
        cases.map((found) => found.row),
      ),
    },
  };
}

/** 候補の番号の列を返す。 */
function numbersOf(items: readonly PrSearchItem[]): number[] {
  return items.map((item) => item.number);
}

/** 所有者`acme`の`tools`のPR。RESTの応答の綴りも`tools`にする。 */
function toolsPrCase(number: number, options: PrCaseOptions = {}) {
  const found = prCase(number, options);
  return {
    ...found,
    row: { ...found.row, repo: "tools" },
    asIssue: {
      ...found.asIssue,
      htmlUrl: `https://github.com/Acme/Tools/pull/${String(number)}`,
      repository: { owner: "Acme", repo: "Tools" },
    },
  };
}

const DIRECT_CONDITIONS: readonly {
  readonly name: string;
  readonly options: PrCaseOptions;
}[] = [
  { name: "with the review label", options: { labels: [REVIEW_LABEL] } },
  { name: "with the fix label", options: { labels: [FIX_LABEL] } },
  { name: "that requests the viewer", options: { requestsViewer: true } },
  {
    name: "that is assigned to the viewer",
    options: { assignedToViewer: true },
  },
];

describe("discoverPrs from the table", () => {
  const target = prCase(3, { labels: [REVIEW_LABEL] });

  test("lists no repository when every repository is fresh", async () => {
    const { listed } = await runPrs(prWorld([target]));
    expect(listed).toEqual([]);
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

  for (const { name, options } of DIRECT_CONDITIONS) {
    test(`finds a pull request ${name} in place of the search`, async () => {
      const { result } = await runPrs(prWorld([prCase(5, options)]));
      expect(numbersOf(result.items)).toEqual([5]);
    });
  }

  test("does not read a row that matches none of the four conditions", async () => {
    const { gotPr } = await runPrs(prWorld([target, prCase(4)]));
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("does not return a row that only another person is requested for", async () => {
    const { result } = await runPrs(prWorld([prCase(4)]));
    expect(result.items).toEqual([]);
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

  test("takes neither a candidate nor a team request from an archived repository", async () => {
    const stray = prCase(9, { team: true });
    const { gotPr } = await runPrs({
      ...prWorld([target]),
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets"), repoRow("old", { archived: true })],
          [target.row, { ...stray.row, repo: "old" }],
        ),
      },
    });
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("takes neither a candidate nor a team request from a repository that is not allowed now", async () => {
    const stray = prCase(9, { team: true });
    const { gotPr } = await runPrs(
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
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("drops a candidate that is no longer a target without a failure", async () => {
    const stale = prCase(3, { labels: [REVIEW_LABEL], staleRow: true });
    const { result, failures } = await runPrs(prWorld([stale]));
    expect([result.items, failures]).toEqual([[], []]);
  });

  test("counts the confirmed candidates", async () => {
    const stale = prCase(4, { labels: [REVIEW_LABEL], staleRow: true });
    const { result } = await runPrs(prWorld([target, stale]));
    expect(result.stats.candidates).toBe(2);
  });

  test("counts the dropped candidates", async () => {
    const stale = prCase(4, { labels: [REVIEW_LABEL], staleRow: true });
    const { result } = await runPrs(prWorld([target, stale]));
    expect(result.stats.dropped).toBe(1);
  });

  test("records a failed read of a pull request and drops only that candidate", async () => {
    const second = prCase(4, { labels: [REVIEW_LABEL] });
    const world = prWorld([target, second]);
    const { result, failures } = await runPrs({
      ...world,
      prs: { ...world.prs, "acme/widgets#3": new Error("boom") },
    });
    expect([failures, numbersOf(result.items), result.failed]).toEqual([
      ["confirm_pr:acme/widgets#3"],
      [4],
      1,
    ]);
  });

  test("records a failed read of an issue and drops only that candidate", async () => {
    const second = prCase(4, { labels: [REVIEW_LABEL] });
    const world = prWorld([target, second]);
    const { result, failures } = await runPrs({
      ...world,
      issues: { ...world.issues, "acme/widgets#3": new Error("boom") },
    });
    expect([failures, numbersOf(result.items)]).toEqual([
      ["confirm_pr:acme/widgets#3"],
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
      ["confirm_pr:acme/widgets#3"],
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
    expect([failures, result.failed, result.stats.dropped]).toEqual([
      ["confirm_pr:acme/widgets#3"],
      1,
      0,
    ]);
  });

  test("judges the freshness with the given threshold", async () => {
    const { result } = await runPrs(staleWorld([target]), {
      ...NOT_EXPLICIT,
      staleAfterMs: STALE_AFTER_MS + 2,
    });
    expect(numbersOf(result.items)).toEqual([3]);
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

describe("discoverPrs skips a stale repository that is not explicit", () => {
  /** toolsが古く、widgetsが新しい所有者。どちらも非明示にする。 */
  function mixed(overrides: Partial<GhOwnerRepoFreshnessRow>): PrFixture {
    const fresh = prCase(3, { labels: [REVIEW_LABEL] });
    const stale = toolsPrCase(7, { labels: [REVIEW_LABEL] });
    const world = restFixtures([fresh]);
    return {
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets"), repoRow("tools", overrides)],
          [fresh.row, stale.row],
        ),
      },
      prs: { ...world.prs, "acme/tools#7": stale.pr },
      issues: { ...world.issues, "acme/tools#7": stale.asIssue },
    };
  }

  for (const { reason, overrides } of STALE_CASES) {
    test(`counts the repository by the reason ${reason}`, async () => {
      const { result } = await runPrs(mixed(overrides), NOT_EXPLICIT);
      expect(result.stats.skipped_stale_reasons).toEqual({ [reason]: 1 });
    });
  }

  test("counts the skipped repositories", async () => {
    const { result } = await runPrs(
      mixed({ last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(result.stats.skipped_stale).toBe(1);
  });

  test("takes the rows of a fresh repository next to a stale one", async () => {
    const { result } = await runPrs(
      mixed({ last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(numbersOf(result.items)).toEqual([3]);
  });

  test("does not read the pull requests of a stale repository", async () => {
    const { gotPr } = await runPrs(
      mixed({ last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("does not list a stale repository by REST", async () => {
    const { listed } = await runPrs(
      mixed({ last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(listed).toEqual([]);
  });

  test("does not record a failure for a skipped repository", async () => {
    const { failures } = await runPrs(
      mixed({ last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(failures).toEqual([]);
  });

  test("counts nothing when every repository is fresh", async () => {
    const { result } = await runPrs(mixed({}), NOT_EXPLICIT);
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("counts both repositories when both are stale", async () => {
    const { result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("tools", { last_collected_at: null }),
            ],
            [],
          ),
        },
      },
      NOT_EXPLICIT,
    );
    expect(result.stats.skipped_stale_reasons).toEqual({
      too_old: 1,
      not_collected: 1,
    });
  });

  test("does not count an archived repository", async () => {
    const { result } = await runPrs(
      mixed({ archived: true, last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("does not count a repository that is gone", async () => {
    const { result } = await runPrs(
      mixed({ gone: true, last_collected_at: TOO_OLD }),
      NOT_EXPLICIT,
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("does not count a repository that is not allowed now", async () => {
    const { result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [repoRow("gadgets", { last_collected_at: TOO_OLD })],
            [],
          ),
        },
      },
      {
        factoryRepo: OUTSIDE_FACTORY,
        repoAllowlist: ["https://github.com/acme/widgets"],
      },
    );
    expect(result.stats.skipped_stale).toBe(0);
  });

  test("builds new reason records for every round", async () => {
    const fixture = mixed({ last_collected_at: TOO_OLD });
    const first = await runPrs(fixture, NOT_EXPLICIT);
    const second = await runPrs(fixture, NOT_EXPLICIT);
    expect(first.result.stats.skipped_stale_reasons).not.toBe(
      second.result.stats.skipped_stale_reasons,
    );
  });

  test("finds nothing of an owner whose table cannot be read, and records the failure", async () => {
    const { result, failures } = await runPrs(
      { snapshots: { acme: new Error("db down") } },
      NOT_EXPLICIT,
    );
    expect([result.items, failures, result.failed]).toEqual([
      [],
      ["read_gh_owner_prs:Acme"],
      1,
    ]);
  });

  test("goes on to the next owner after a failed read of the table", async () => {
    const found = prCase(3, { labels: [REVIEW_LABEL] });
    const world = prWorld([found]);
    const { result } = await runPrs(
      {
        ...world,
        snapshots: {
          beta: new Error("db down"),
          acme: world.snapshots?.acme ?? new Error("missing"),
        },
      },
      { ...NOT_EXPLICIT, owners: [BETA, ACME] },
    );
    expect(numbersOf(result.items)).toEqual([3]);
  });
});

describe("discoverPrs reads a row that a team may have requested", () => {
  /** 表の行は依頼先を決められないので、直接の依頼は`getPr`の応答で決める。 */
  function teamWorld(
    restOverrides: Partial<PullRequest>,
    caseOptions: PrCaseOptions = { team: true },
    rowOverrides: Partial<GhPullRequest> = {},
  ): PrFixture {
    const found = prCase(4, caseOptions);
    const world = prWorld([
      { ...found, row: { ...found.row, ...rowOverrides } },
    ]);
    return {
      ...world,
      prs: { "acme/widgets#4": { ...found.pr, ...restOverrides } },
    };
  }

  test("reads the pull request of a team row by REST", async () => {
    const { gotPr } = await runPrs(teamWorld({}));
    expect(gotPr).toEqual(["acme/widgets#4"]);
  });

  test("finds a team row whose reviewer list names the viewer", async () => {
    const { result } = await runPrs(
      teamWorld({ requestedReviewerIds: [VIEWER_ID] }),
    );
    expect(numbersOf(result.items)).toEqual([4]);
  });

  test("skips a pull request that only a team requested", async () => {
    const { result } = await runPrs(
      teamWorld({ requestedReviewerIds: [OTHER_ID] }),
    );
    expect(result.items).toEqual([]);
  });

  test("counts a pull request that only a team requested as unresolved", async () => {
    const { result } = await runPrs(
      teamWorld({ requestedReviewerIds: [OTHER_ID] }),
    );
    expect(result.stats.team_unresolved).toBe(1);
  });

  test("does not count a team row that was found by the direct request", async () => {
    const { result } = await runPrs(
      teamWorld({ requestedReviewerIds: [VIEWER_ID] }),
    );
    expect(result.stats.team_unresolved).toBe(0);
  });

  test("does not record a failure for a pull request that only a team requested", async () => {
    const { failures } = await runPrs(
      teamWorld({ requestedReviewerIds: [OTHER_ID] }),
    );
    expect(failures).toEqual([]);
  });

  test("does not count a pull request that only a team requested as dropped", async () => {
    const { result } = await runPrs(
      teamWorld({ requestedReviewerIds: [OTHER_ID] }),
    );
    expect(result.stats.dropped).toBe(0);
  });

  test("reads a row whose team request is unknown by REST", async () => {
    const { result } = await runPrs(
      teamWorld(
        { requestedReviewerIds: [VIEWER_ID] },
        {},
        { team_review_requested: null },
      ),
    );
    expect(numbersOf(result.items)).toEqual([4]);
  });

  test("counts a row whose team request is unknown and whose direct request is not the viewer", async () => {
    const { result } = await runPrs(
      teamWorld(
        { requestedReviewerIds: [OTHER_ID] },
        {},
        { team_review_requested: null },
      ),
    );
    expect(result.stats.team_unresolved).toBe(1);
  });

  test("reads a row whose requested reviewers are unknown by REST", async () => {
    const { result } = await runPrs(
      teamWorld(
        { requestedReviewerIds: [VIEWER_ID] },
        {},
        { review_requested_user_ids: null, team_review_requested: false },
      ),
    );
    expect(numbersOf(result.items)).toEqual([4]);
  });

  test("does not count a row without a team request as unresolved", async () => {
    const { result } = await runPrs(
      teamWorld(
        { requestedReviewerIds: [OTHER_ID] },
        {},
        { review_requested_user_ids: null, team_review_requested: false },
      ),
    );
    expect(result.stats.team_unresolved).toBe(0);
  });

  test("records an unreadable reviewer list of a team row as a failure", async () => {
    const { failures } = await runPrs(
      teamWorld({ requestedReviewerIds: null }),
    );
    expect(failures).toEqual(["confirm_pr:acme/widgets#4"]);
  });

  test("reads the team rows of an organization and of a user the same way", async () => {
    const acme = prCase(4, { team: true });
    const beta = toolsPrCase(8, { team: true });
    const { result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot([repoRow("widgets")], [acme.row]),
          beta: prSnapshot(
            [repoRow("tools")],
            [{ ...beta.row, owner: "beta" }],
          ),
        },
        prs: {
          "acme/widgets#4": acme.pr,
          "beta/tools#8": beta.pr,
        },
        issues: {
          "acme/widgets#4": acme.asIssue,
          "beta/tools#8": {
            ...beta.asIssue,
            repository: { owner: "Beta", repo: "Tools" },
          },
        },
      },
      { owners: [ACME, BETA] },
    );
    expect(result.stats.team_unresolved).toBe(2);
  });

  test("does not list a repository for a team row", async () => {
    const { listed } = await runPrs(
      teamWorld({ requestedReviewerIds: [OTHER_ID] }),
    );
    expect(listed).toEqual([]);
  });

  test("keeps the other candidates of the owner next to a team row", async () => {
    const team = prCase(4, { team: true });
    const labeled = prCase(3, { labels: [REVIEW_LABEL] });
    const { result } = await runPrs(prWorld([labeled, team]));
    expect(numbersOf(result.items)).toEqual([3]);
  });
});

describe("discoverPrs reads an explicit repository by REST when the table cannot be used", () => {
  const found = prCase(3, { labels: [REVIEW_LABEL] });

  for (const { reason, overrides } of STALE_CASES) {
    test(`lists the repository by REST for the reason ${reason}`, async () => {
      const { listed } = await runPrs(staleWorld([found], overrides));
      expect(listed).toEqual(["acme/widgets"]);
    });

    test(`reports the reason ${reason}`, async () => {
      const { result } = await runPrs(staleWorld([found], overrides));
      expect(result.stats.rest_reasons).toEqual({ [reason]: 1 });
    });
  }

  test("does not list an explicit repository whose record is fresh", async () => {
    const { listed } = await runPrs(prWorld([found]));
    expect(listed).toEqual([]);
  });

  test("returns the confirmed candidates of the list in the spelling of GitHub", async () => {
    const { result } = await runPrs(staleWorld([found]));
    expect(result.items).toEqual([prSearchItem(3)]);
  });

  test("lists the repository when it has no gh_repos row", async () => {
    const { listed } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: prSnapshot([repoRow("tools")], []) },
    });
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reports no_record when the repository has no gh_repos row", async () => {
    const { result } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: prSnapshot([], []) },
    });
    expect(result.stats.rest_reasons).toEqual({ no_record: 1 });
  });

  test("lists the repository when it is gone", async () => {
    const { listed } = await runPrs(staleWorld([found], { gone: true }));
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("records a failure when the list of a gone repository is not found", async () => {
    const { failures } = await runPrs({
      ...staleWorld([found], { gone: true }),
      listings: { "acme/widgets": new Error("HTTP 404") },
    });
    expect(failures).toEqual(["list_open_prs:acme/widgets"]);
  });

  test("does not list an archived repository whose record is fresh", async () => {
    const { listed } = await runPrs(staleWorld([found], { archived: true }));
    expect(listed).toEqual([]);
  });

  test("does not count an archived repository whose record is fresh", async () => {
    const { result } = await runPrs(staleWorld([found], { archived: true }));
    expect(result.stats.rest_lists).toBe(0);
  });

  test("lists an archived repository whose record is too old", async () => {
    const { listed } = await runPrs(
      staleWorld([found], { archived: true, last_collected_at: TOO_OLD }),
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("lists an archived repository whose record was never collected", async () => {
    const { listed } = await runPrs(
      staleWorld([found], { archived: true, last_collected_at: null }),
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reads a number once when the pages of the list overlap", async () => {
    const { gotPr } = await runPrs({
      ...staleWorld([found]),
      listings: { "acme/widgets": [found.listed, found.listed] },
    });
    expect(gotPr).toEqual(["acme/widgets#3"]);
  });

  test("returns a pull request once when the pages of the list overlap", async () => {
    const { result } = await runPrs({
      ...staleWorld([found]),
      listings: { "acme/widgets": [found.listed, found.listed] },
    });
    expect(result.items).toEqual([prSearchItem(3)]);
  });

  test("counts the repositories read by REST", async () => {
    const { result } = await runPrs(staleWorld([found]));
    expect(result.stats.rest_lists).toBe(1);
  });

  test("lists every explicit repository of the allowlist that is stale", async () => {
    const { listed } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [],
          ),
        },
        listings: { "acme/widgets": [], "acme/gadgets": [] },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(listed).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  test("lists only the stale one when another explicit repository is fresh", async () => {
    const { listed } = await runPrs(
      {
        ...prWorld([found]),
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets"),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [found.row],
          ),
        },
        listings: { "acme/gadgets": [] },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(listed).toEqual(["acme/gadgets"]);
  });

  test("returns the table candidates before the listed ones", async () => {
    const gadgets = prCase(8, { labels: [REVIEW_LABEL] });
    const { result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets"),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [found.row],
          ),
        },
        listings: { "acme/gadgets": [gadgets.listed] },
        prs: { "acme/widgets#3": found.pr, "acme/gadgets#8": gadgets.pr },
        issues: {
          "acme/widgets#3": found.asIssue,
          "acme/gadgets#8": {
            ...gadgets.asIssue,
            repository: { owner: "Acme", repo: "Gadgets" },
          },
        },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect(
      result.items.map((item) => `${item.repo}#${String(item.number)}`),
    ).toEqual(["Widgets#3", "Gadgets#8"]);
  });

  test("does not list an explicit repository of an owner that is not verified", async () => {
    const { listed } = await runPrs(
      {
        ...staleWorld([found]),
        snapshots: { beta: prSnapshot([], []) },
      },
      { owners: [BETA] },
    );
    expect(listed).toEqual([]);
  });

  test("lists an explicit repository under its own owner only", async () => {
    const { listed } = await runPrs(
      {
        ...staleWorld([found]),
        snapshots: {
          acme: prSnapshot(
            [repoRow("widgets", { last_collected_at: TOO_OLD })],
            [],
          ),
          beta: prSnapshot([], []),
        },
      },
      {
        owners: [ACME, BETA],
        repoAllowlist: ["https://github.com/acme/widgets"],
      },
    );
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("does not list the factory repository of an owner that is not in the owners", async () => {
    const { listed } = await runPrs(
      {
        snapshots: { acme: prSnapshot([], []) },
        listings: { "outside/factory": [] },
      },
      { factoryRepo: OUTSIDE_FACTORY },
    );
    expect(listed).toEqual([]);
  });

  test("lists the repository and records a failure when the table cannot be read", async () => {
    const { listed, failures } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: new Error("db down") },
    });
    expect([listed, failures]).toEqual([
      ["acme/widgets"],
      ["read_gh_owner_prs:Acme"],
    ]);
  });

  test("counts a failed read of the table as a failure of the round", async () => {
    const { result } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: new Error("db down") },
    });
    expect(result.failed).toBe(1);
  });

  test("reports read_failed when the table cannot be read", async () => {
    const { result } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: new Error("db down") },
    });
    expect(result.stats.rest_reasons).toEqual({ read_failed: 1 });
  });

  test("finds the pull request of the list when the table cannot be read", async () => {
    const { result } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: new Error("db down") },
    });
    expect(numbersOf(result.items)).toEqual([3]);
  });

  test("does not read the table when the collection is off", async () => {
    const { read } = await runPrs(prWorld([found]), { useTable: false });
    expect(read).toEqual([]);
  });

  test("lists the explicit repository when the collection is off", async () => {
    const { listed } = await runPrs(prWorld([found]), { useTable: false });
    expect(listed).toEqual(["acme/widgets"]);
  });

  test("reports collect_disabled when the collection is off", async () => {
    const { result } = await runPrs(prWorld([found]), { useTable: false });
    expect(result.stats.rest_reasons).toEqual({ collect_disabled: 1 });
  });

  test("finds nothing outside the explicit repositories when the collection is off", async () => {
    const { result } = await runPrs(prWorld([found]), {
      useTable: false,
      ...NOT_EXPLICIT,
    });
    expect(result.items).toEqual([]);
  });

  test("records a failed list and goes on to the next repository", async () => {
    const gadgets = prCase(8, { labels: [REVIEW_LABEL] });
    const { failures, result } = await runPrs(
      {
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [],
          ),
        },
        listings: {
          "acme/widgets": new Error("boom"),
          "acme/gadgets": [gadgets.listed],
        },
        prs: { "acme/gadgets#8": gadgets.pr },
        issues: {
          "acme/gadgets#8": {
            ...gadgets.asIssue,
            repository: { owner: "Acme", repo: "Gadgets" },
          },
        },
      },
      {
        repoAllowlist: [
          "https://github.com/acme/widgets",
          "https://github.com/acme/gadgets",
        ],
      },
    );
    expect([failures, numbersOf(result.items)]).toEqual([
      ["list_open_prs:acme/widgets"],
      [8],
    ]);
  });
});

describe("discoverPrs takes only a candidate from the list and confirms it by REST", () => {
  for (const { name, options } of DIRECT_CONDITIONS) {
    test(`finds a listed pull request ${name}`, async () => {
      const { result } = await runPrs(staleWorld([prCase(5, options)]));
      expect(numbersOf(result.items)).toEqual([5]);
    });
  }

  test("does not read a listed pull request that matches none of the four conditions", async () => {
    const { gotPr } = await runPrs(staleWorld([prCase(4)]));
    expect(gotPr).toEqual([]);
  });

  test("does not return a listed pull request that only another person is requested for", async () => {
    const { result } = await runPrs(staleWorld([prCase(4)]));
    expect(result.items).toEqual([]);
  });

  test("drops a listed candidate that REST no longer shows as a target", async () => {
    const stale = prCase(4, { requestsViewer: true, staleRow: true });
    const { result } = await runPrs(staleWorld([stale]));
    expect(result.items).toEqual([]);
  });

  test("counts the dropped listed candidate", async () => {
    const stale = prCase(4, { labels: [REVIEW_LABEL], staleRow: true });
    const { result } = await runPrs(staleWorld([stale]));
    expect(result.stats.dropped).toBe(1);
  });

  test("reads a listed pull request whose labels are unknown by REST", async () => {
    const found = prCase(6, { labels: [REVIEW_LABEL] });
    const { result } = await runPrs(
      staleWorld([{ ...found, listed: { ...found.listed, labels: null } }]),
    );
    expect(numbersOf(result.items)).toEqual([6]);
  });

  test("reads a listed pull request whose fields are missing by REST", async () => {
    const found = prCase(6, { labels: [REVIEW_LABEL] });
    const bare: OpenPullRequest = {
      number: found.listed.number,
      draft: found.listed.draft,
      headRef: found.listed.headRef,
      headRepoFullName: found.listed.headRepoFullName,
      baseRepoFullName: found.listed.baseRepoFullName,
      authorLogin: found.listed.authorLogin,
      authorId: found.listed.authorId,
    };
    const { result } = await runPrs(staleWorld([{ ...found, listed: bare }]));
    expect(numbersOf(result.items)).toEqual([6]);
  });

  test("reads a listed pull request that a team requested by REST", async () => {
    const { gotPr } = await runPrs(staleWorld([prCase(4, { team: true })]));
    expect(gotPr).toEqual(["acme/widgets#4"]);
  });

  test("counts a listed pull request that only a team requested as unresolved", async () => {
    const { result } = await runPrs(staleWorld([prCase(4, { team: true })]));
    expect(result.stats.team_unresolved).toBe(1);
  });

  test("keeps a fork pull request for the downstream checks", async () => {
    const { result } = await runPrs(
      staleWorld([prCase(1, { labels: [REVIEW_LABEL], fork: true })]),
    );
    expect(numbersOf(result.items)).toEqual([1]);
  });

  test("keeps a draft pull request for the downstream checks", async () => {
    const { result } = await runPrs(
      staleWorld([prCase(2, { assignedToViewer: true, draft: true })]),
    );
    expect(numbersOf(result.items)).toEqual([2]);
  });

  test("orders the listed candidates by number", async () => {
    const { result } = await runPrs(
      staleWorld([
        prCase(9, { labels: [REVIEW_LABEL] }),
        prCase(2, { labels: [FIX_LABEL] }),
      ]),
    );
    expect(numbersOf(result.items)).toEqual([2, 9]);
  });
});

describe("the table and the list find the same pull requests", () => {
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

  /** 表の経路と一覧の経路の項目を、許可リストを当ててから返す。 */
  async function both(
    cases: readonly PrCase[],
  ): Promise<{ table: PrSearchItem[]; list: PrSearchItem[] }> {
    const scope = scopeOf([ACME], []);
    const table = await runPrs(prWorld(cases));
    const list = await runPrs(staleWorld(cases));
    return {
      table: filterByRepoAllowlist(table.result.items, scope),
      list: filterByRepoAllowlist(list.result.items, scope),
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
    const { table, list } = await both(mixed);
    expect(list).toEqual(table);
  });

  test("makes the same decisions for labels, direct requests, assignees and others", async () => {
    const { table, list } = await both(mixed);
    expect(decisionsOf(list, mixed)).toEqual(decisionsOf(table, mixed));
  });

  const hostile = [
    prCase(1, { labels: [REVIEW_LABEL], fork: true }),
    prCase(2, { assignedToViewer: true, draft: true }),
    prCase(3, { assignedToViewer: true, author: "mallory" }),
    prCase(4, { labels: [FIX_LABEL], author: "mallory" }),
  ];

  test("makes the same decisions for forks, drafts and authors that are not allowed", async () => {
    const { table, list } = await both(hostile);
    expect(decisionsOf(list, hostile)).toEqual(decisionsOf(table, hostile));
  });

  test("refuses the review of a fork head in both routes", async () => {
    const { table, list } = await both(hostile);
    const refused = (items: readonly PrSearchItem[]) =>
      decisionsOf(items, hostile).find((decision) => decision.number === 1)
        ?.review.kind;
    expect([refused(table), refused(list)]).toEqual([
      "deny_fork_head",
      "deny_fork_head",
    ]);
  });

  const withStaleRows = [
    prCase(1, { labels: [REVIEW_LABEL] }),
    prCase(2, { labels: [REVIEW_LABEL], staleRow: true }),
    prCase(3, { assignedToViewer: true, staleRow: true }),
    prCase(4, { labels: [FIX_LABEL], closed: true }),
  ];

  test("drops stale rows by REST in both routes", async () => {
    const { table, list } = await both(withStaleRows);
    expect(list).toEqual(table);
  });

  test("leaves a dropped candidate to the tracked pull requests", async () => {
    const { list } = await both(withStaleRows);
    expect(numbersOf(list)).toEqual([1]);
  });

  test("gives the work item the spelling of GitHub", async () => {
    const { list } = await both([prCase(1, { labels: [FIX_LABEL] })]);
    expect(
      list.map((item) => `${item.owner}/${item.repo}#${String(item.number)}`),
    ).toEqual(["Acme/Widgets#1"]);
  });

  test("agrees when the set includes a repository that is not allowed", async () => {
    const found = prCase(3, { labels: [REVIEW_LABEL] });
    const stray = prCase(9, { labels: [REVIEW_LABEL] });
    const options: PrOptions = {
      repoAllowlist: ["https://github.com/acme/widgets"],
    };
    const scope = scopeOf([ACME], options.repoAllowlist ?? []);
    const world = prWorld([found]);
    const fixture: PrFixture = {
      ...world,
      listings: {
        "acme/widgets": [found.listed],
        "acme/gadgets": [stray.listed],
      },
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets"), repoRow("gadgets")],
          [found.row, { ...stray.row, repo: "gadgets" }],
        ),
      },
    };
    const table = await runPrs(fixture, options);
    const list = await runPrs(
      {
        ...fixture,
        snapshots: {
          acme: prSnapshot(
            [
              repoRow("widgets", { last_collected_at: TOO_OLD }),
              repoRow("gadgets", { last_collected_at: TOO_OLD }),
            ],
            [],
          ),
        },
      },
      options,
    );
    expect(filterByRepoAllowlist(list.result.items, scope)).toEqual(
      filterByRepoAllowlist(table.result.items, scope),
    );
  });
});

describe("the differences of the pull requests that are accepted", () => {
  test("a new request that is not in the table yet is found by the list only", async () => {
    const known = prCase(3, { labels: [REVIEW_LABEL] });
    const fresh = prCase(9, { requestsViewer: true });
    const world = prWorld([known, fresh]);
    const fixture: PrFixture = {
      ...world,
      snapshots: {
        acme: prSnapshot([repoRow("widgets")], [known.row]),
      },
    };
    const table = await runPrs(fixture);
    const list = await runPrs({
      ...fixture,
      snapshots: {
        acme: prSnapshot(
          [repoRow("widgets", { last_collected_at: TOO_OLD })],
          [],
        ),
      },
    });
    expect([
      numbersOf(table.result.items),
      numbersOf(list.result.items),
    ]).toEqual([[3], [3, 9]]);
  });
});

describe("the round of the pull requests does not stop when the table cannot be used", () => {
  const found = prCase(3, { labels: [REVIEW_LABEL] });

  test("finds the explicit repository by the list when every owner is too old", async () => {
    const { result } = await runPrs(staleWorld([found]));
    expect(numbersOf(result.items)).toEqual([3]);
  });

  test("finds the explicit repository by the list when every read fails", async () => {
    const { result } = await runPrs({
      ...prWorld([found]),
      snapshots: { acme: new Error("down") },
    });
    expect(numbersOf(result.items)).toEqual([3]);
  });

  test("finds the explicit repository by the list when the collection is off", async () => {
    const { result } = await runPrs(prWorld([found]), { useTable: false });
    expect(numbersOf(result.items)).toEqual([3]);
  });
});

describe("discoverPrs never calls a search endpoint", () => {
  /** 実際の`listOpenPullRequests`、`getPr`、`getIssue`を、呼ばれたendpointを記録する偽の`gh`に通す。 */
  async function discoverWithRealReaders(options: PrOptions) {
    const endpoints: string[] = [];
    const client = {
      ghToken: "tok",
      run: async (argv: readonly string[]) => {
        const endpoint =
          argv.find(
            (arg) => arg.startsWith("repos/") || arg.startsWith("search/"),
          ) ?? "";
        endpoints.push(endpoint);
        if (endpoint.includes("/pulls?state=open")) {
          return ghApiOk([
            {
              number: 3,
              draft: false,
              head: { ref: "feature", repo: { full_name: "Acme/Widgets" } },
              base: { ref: "main", repo: { full_name: "Acme/Widgets" } },
              user: { login: "alice", id: 1001 },
              labels: [{ name: REVIEW_LABEL }],
              assignees: [],
              requested_reviewers: [],
              requested_teams: [],
            },
          ]);
        }
        if (endpoint.includes("/pulls/")) {
          return ghApiOk({
            number: 3,
            title: "pr title 3",
            body: "",
            draft: false,
            state: "open",
            merged: false,
            head: {
              sha: "b".repeat(40),
              ref: "feature",
              repo: { full_name: "Acme/Widgets" },
            },
            base: {
              ref: "main",
              repo: { full_name: "Acme/Widgets", id: REPO_ID },
            },
            mergeable: null,
            mergeable_state: null,
            user: { login: "alice", id: 1001, type: "User" },
            auto_merge: null,
            requested_reviewers: [],
          });
        }
        return ghApiOk({
          number: 3,
          title: "pr title 3",
          body: "",
          html_url: "https://github.com/Acme/Widgets/pull/3",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: REVIEW_LABEL }],
          assignees: [],
          repository_url: "https://api.github.com/repos/Acme/Widgets",
          pull_request: {},
        });
      },
    };
    const owners = options.owners ?? [ACME];
    const log: Logger = { info() {}, warn() {}, error() {} };
    const result = await discoverPrs(
      {
        useTable: options.useTable ?? true,
        owners,
        scope: scopeOf(owners, []),
        viewer: VIEWER,
        labels: PR_LABELS,
        staleAfterMs: STALE_AFTER_MS,
        log,
      },
      {
        readOwnerPrs: async () =>
          prSnapshot([repoRow("widgets", { last_collected_at: TOO_OLD })], []),
        listOpenPrs: (owner, repo) => listOpenPullRequests(client, owner, repo),
        getPr: (owner, repo, number) => getPr(client, owner, repo, number),
        getIssue: (owner, repo, number) =>
          getIssue(client, owner, repo, number),
        recordFailure: async () => {},
      },
    );
    return { result, endpoints };
  }

  test("reads the explicit repository through the pulls endpoints only", async () => {
    const { endpoints } = await discoverWithRealReaders({});
    expect(endpoints.filter((endpoint) => endpoint.includes("search"))).toEqual(
      [],
    );
  });

  test("finds the labeled pull request", async () => {
    const { result } = await discoverWithRealReaders({});
    expect(numbersOf(result.items)).toEqual([3]);
  });

  test("does not call a search endpoint when the collection is off", async () => {
    const { endpoints } = await discoverWithRealReaders({ useTable: false });
    expect(endpoints.filter((endpoint) => endpoint.includes("search"))).toEqual(
      [],
    );
  });

  test("does not call a search endpoint for a team row", async () => {
    const team = prCase(4, { team: true });
    const endpoints: string[] = [];
    const log: Logger = { info() {}, warn() {}, error() {} };
    const client = {
      ghToken: "tok",
      run: async (argv: readonly string[]) => {
        endpoints.push(argv.find((arg) => arg.includes("/")) ?? "");
        return ghApiOk({ message: "not found" });
      },
    };
    await discoverPrs(
      {
        useTable: true,
        owners: [ACME],
        scope: scopeOf([ACME], []),
        viewer: VIEWER,
        labels: PR_LABELS,
        staleAfterMs: STALE_AFTER_MS,
        log,
      },
      {
        readOwnerPrs: async () => prSnapshot([repoRow("widgets")], [team.row]),
        listOpenPrs: (owner, repo) => listOpenPullRequests(client, owner, repo),
        getPr: (owner, repo, number) => getPr(client, owner, repo, number),
        getIssue: (owner, repo, number) =>
          getIssue(client, owner, repo, number),
        recordFailure: async () => {},
      },
    );
    expect(endpoints.filter((endpoint) => endpoint.includes("search"))).toEqual(
      [],
    );
  });
});
