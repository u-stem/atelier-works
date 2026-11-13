import { describe, expect, test } from "bun:test";
import { staleNotifyThresholdMs } from "../../f/factory/lib/gh_collect_freshness.ts";
import {
  ghDetailStaleAfterMs,
  judgeGhOwnerIssueRepos,
  judgeGhOwnerRepos,
  judgeGhRepoFreshness,
  nonExplicitReposPossible,
  repoStaleTargetFilter,
  summarizeRepoStale,
  usableGhDetailRows,
  usableGhPullRequests,
  usableTableRows,
} from "../../f/factory/lib/gh_collect_read.ts";
import type {
  FactoryConfig,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhRepoFreshnessRow,
  GhRepoStaleProbe,
  GhRepoStaleReasonCounts,
} from "../../f/factory/lib/types.ts";

// 収集の記録を下流が読んでよいかの判定のテスト。
// 鮮度の判定、判断を止める閾値、使ってよい行の絞り込みを確かめる。
const MINUTE_MS = 60_000;
const DB_NOW = new Date("2026-10-18T00:00:00.000Z");
const STALE_AFTER_MS = 15 * MINUTE_MS;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO_ID = 4242;

function repoRow(
  overrides: Partial<GhRepoFreshnessRow> = {},
): GhRepoFreshnessRow {
  return {
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

function prRow(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    repo_id: REPO_ID,
    number: 7,
    state: "open",
    head_sha: SHA,
    head_ref: "dependabot/npm_and_yarn/left-pad-1.3.1",
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "dependabot",
    author_type: "Bot",
    author_id: 49699333,
    mergeable: "MERGEABLE",
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

function judge(
  repo: GhRepoFreshnessRow | null,
  rows: readonly GhPullRequest[] = [],
) {
  return judgeGhRepoFreshness(repo, rows, DB_NOW, STALE_AFTER_MS);
}

describe("judgeGhRepoFreshness", () => {
  test("treats a last_collected_at inside the threshold as fresh", () => {
    expect(judge(repoRow())).toEqual({ kind: "fresh" });
  });

  test("treats a last_collected_at exactly at the threshold as fresh", () => {
    const repo = repoRow({
      last_collected_at: new Date(DB_NOW.getTime() - STALE_AFTER_MS),
    });

    expect(judge(repo)).toEqual({ kind: "fresh" });
  });

  test("treats a last_collected_at one millisecond past the threshold as too old", () => {
    const repo = repoRow({
      last_collected_at: new Date(DB_NOW.getTime() - STALE_AFTER_MS - 1),
    });

    expect(judge(repo)).toEqual({ kind: "stale", reason: "too_old" });
  });

  test("reports no_record when gh_repos has no row", () => {
    expect(judge(null)).toEqual({ kind: "stale", reason: "no_record" });
  });

  test("reports not_collected when last_collected_at is null", () => {
    expect(judge(repoRow({ last_collected_at: null }))).toEqual({
      kind: "stale",
      reason: "not_collected",
    });
  });

  test("reports unusable when repo_id is null", () => {
    expect(judge(repoRow({ repo_id: null }))).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("reports unusable when the repository is not allowed", () => {
    expect(judge(repoRow({ allowed: false }))).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("reports unusable when the repository is gone", () => {
    expect(judge(repoRow({ gone: true }))).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("reports unusable when the repository is archived", () => {
    expect(judge(repoRow({ archived: true }))).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("reports unusable when every open row is marked unusable", () => {
    const rows = [
      prRow({ usable: false }),
      prRow({ number: 8, usable: false }),
    ];

    expect(judge(repoRow(), rows)).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("reports unusable when every open row has another repo_id", () => {
    const rows = [prRow({ repo_id: REPO_ID + 1 })];

    expect(judge(repoRow(), rows)).toEqual({
      kind: "stale",
      reason: "unusable",
    });
  });

  test("stays fresh when only some open rows are unusable", () => {
    const rows = [prRow({ usable: false }), prRow({ number: 8 })];

    expect(judge(repoRow(), rows)).toEqual({ kind: "fresh" });
  });

  test("does not apply the unusable-rows rule to zero open rows", () => {
    expect(judge(repoRow(), [])).toEqual({ kind: "fresh" });
  });

  test("reports in_future when last_collected_at is after the database time", () => {
    const repo = repoRow({ last_collected_at: new Date(DB_NOW.getTime() + 1) });

    expect(judge(repo)).toEqual({ kind: "stale", reason: "in_future" });
  });

  test("applies unusable before not_collected", () => {
    const repo = repoRow({ gone: true, last_collected_at: null });

    expect(judge(repo)).toEqual({ kind: "stale", reason: "unusable" });
  });
});

describe("ghDetailStaleAfterMs", () => {
  test("is 15 minutes for one owner", () => {
    expect(ghDetailStaleAfterMs(1)).toBe(15 * MINUTE_MS);
  });

  test("is 20 minutes for three owners", () => {
    expect(ghDetailStaleAfterMs(3)).toBe(20 * MINUTE_MS);
  });

  test("never falls below 15 minutes even for zero owners", () => {
    expect(ghDetailStaleAfterMs(0)).toBe(15 * MINUTE_MS);
  });

  test("stays shorter than the notification threshold for zero to fifty owners", () => {
    const shorter = Array.from({ length: 51 }, (_, n) => n).every(
      (n) => ghDetailStaleAfterMs(n) < staleNotifyThresholdMs(n),
    );

    expect(shorter).toBe(true);
  });
});

describe("usableGhPullRequests", () => {
  function usable(rows: readonly GhPullRequest[], owner = "acme") {
    return usableGhPullRequests(owner, "widgets", REPO_ID, rows);
  }

  test("keeps an open usable row with the same repo_id", () => {
    const row = prRow();

    expect(usable([row])).toEqual([row]);
  });

  test("drops a row that is marked unusable", () => {
    expect(usable([prRow({ usable: false })])).toEqual([]);
  });

  test("drops a row whose repo_id differs from gh_repos", () => {
    expect(usable([prRow({ repo_id: REPO_ID + 1 })])).toEqual([]);
  });

  test("drops a closed row", () => {
    expect(usable([prRow({ state: "closed" })])).toEqual([]);
  });

  test("drops a row of another repository", () => {
    expect(usable([prRow({ repo: "gadgets" })])).toEqual([]);
  });

  test("keeps a lowercase row for a query name with uppercase letters", () => {
    const row = prRow();

    expect(usableGhPullRequests("Acme", "Widgets", REPO_ID, [row])).toEqual([
      row,
    ]);
  });
});

function ownerRepoRow(
  repo: string,
  overrides: Partial<GhOwnerRepoFreshnessRow> = {},
): GhOwnerRepoFreshnessRow {
  return { ...repoRow(), repo, ...overrides };
}

function snapshot(
  repos: readonly GhOwnerRepoFreshnessRow[],
  prs: readonly GhPullRequest[] = [],
): GhOwnerOpenPrSnapshot {
  return { db_now: DB_NOW, repos, prs };
}

const TOO_OLD = new Date(DB_NOW.getTime() - STALE_AFTER_MS - 1);

describe("judgeGhOwnerRepos", () => {
  test("ignores open rows of a repository that has no gh_repos row", () => {
    const snap = snapshot([], [prRow({ repo: "orphan" })]);

    expect([...judgeGhOwnerRepos("acme", snap, STALE_AFTER_MS).keys()]).toEqual(
      [],
    );
  });

  test("judges each repository against the database time of the read", () => {
    const snap = snapshot([
      ownerRepoRow("widgets", {
        last_collected_at: new Date(DB_NOW.getTime() - STALE_AFTER_MS),
      }),
      ownerRepoRow("gadgets", { last_collected_at: TOO_OLD }),
    ]);

    const judged = judgeGhOwnerRepos("acme", snap, STALE_AFTER_MS);

    expect(
      [...judged.entries()].map(([name, item]) => [name, item.freshness.kind]),
    ).toEqual([
      ["widgets", "fresh"],
      ["gadgets", "stale"],
    ]);
  });

  test("judges lowercase rows for an owner name with uppercase letters", () => {
    const snap = snapshot([ownerRepoRow("widgets")], [prRow()]);

    const judged = judgeGhOwnerRepos("Acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.freshness).toEqual({ kind: "fresh" });
  });

  test("keeps only usable open rows with the matching repo_id of a fresh repository", () => {
    const keep = prRow({ number: 1, repo: "widgets" });
    const snap = snapshot(
      [ownerRepoRow("widgets")],
      [
        keep,
        prRow({ number: 2, repo: "widgets", usable: false }),
        prRow({ number: 3, repo: "widgets", repo_id: REPO_ID + 1 }),
      ],
    );

    const judged = judgeGhOwnerRepos("acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.usable).toEqual([keep]);
  });

  test("returns no usable rows for a stale repository", () => {
    const snap = snapshot(
      [ownerRepoRow("widgets", { last_collected_at: TOO_OLD })],
      [prRow({ repo: "widgets" })],
    );

    const judged = judgeGhOwnerRepos("acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.usable).toEqual([]);
  });
});

function issueRow(overrides: Partial<GhIssue> = {}): GhIssue {
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

function issueSnapshot(
  repos: readonly GhOwnerRepoFreshnessRow[],
  issues: readonly GhIssue[] = [],
): GhOwnerOpenIssueSnapshot {
  return { db_now: DB_NOW, repos, issues };
}

describe("judgeGhRepoFreshness with issue rows", () => {
  test("reports unusable when every open issue row is marked unusable", () => {
    expect(
      judgeGhRepoFreshness(
        repoRow(),
        [issueRow({ usable: false })],
        DB_NOW,
        STALE_AFTER_MS,
      ),
    ).toEqual({ kind: "stale", reason: "unusable" });
  });

  test("stays fresh when only some open issue rows are unusable", () => {
    expect(
      judgeGhRepoFreshness(
        repoRow(),
        [issueRow(), issueRow({ number: 4, usable: false })],
        DB_NOW,
        STALE_AFTER_MS,
      ),
    ).toEqual({ kind: "fresh" });
  });
});

describe("usableGhDetailRows", () => {
  function usable(rows: readonly GhIssue[]) {
    return usableGhDetailRows("acme", "widgets", REPO_ID, rows);
  }

  test("keeps an open usable row with the same repo_id", () => {
    const row = issueRow();

    expect(usable([row])).toEqual([row]);
  });

  test("drops a row that is marked unusable", () => {
    expect(usable([issueRow({ usable: false })])).toEqual([]);
  });

  test("drops a row whose repo_id differs from gh_repos", () => {
    expect(usable([issueRow({ repo_id: REPO_ID + 1 })])).toEqual([]);
  });

  test("drops a row of another repository", () => {
    expect(usable([issueRow({ repo: "gadgets" })])).toEqual([]);
  });
});

describe("judgeGhOwnerIssueRepos", () => {
  test("judges each repository against the database time of the read", () => {
    const snap = issueSnapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { last_collected_at: TOO_OLD }),
    ]);

    const judged = judgeGhOwnerIssueRepos("acme", snap, STALE_AFTER_MS);

    expect(
      [...judged.entries()].map(([name, item]) => [name, item.freshness.kind]),
    ).toEqual([
      ["widgets", "fresh"],
      ["gadgets", "stale"],
    ]);
  });

  test("ignores open rows of a repository that has no gh_repos row", () => {
    const snap = issueSnapshot([], [issueRow({ repo: "orphan" })]);

    expect([
      ...judgeGhOwnerIssueRepos("acme", snap, STALE_AFTER_MS).keys(),
    ]).toEqual([]);
  });

  test("judges lowercase rows for an owner name with uppercase letters", () => {
    const snap = issueSnapshot([ownerRepoRow("widgets")], [issueRow()]);

    const judged = judgeGhOwnerIssueRepos("Acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.usable).toEqual([issueRow()]);
  });

  test("keeps only usable open rows with the matching repo_id of a fresh repository", () => {
    const keep = issueRow({ number: 1 });
    const snap = issueSnapshot(
      [ownerRepoRow("widgets")],
      [
        keep,
        issueRow({ number: 2, usable: false }),
        issueRow({ number: 3, repo_id: REPO_ID + 1 }),
      ],
    );

    const judged = judgeGhOwnerIssueRepos("acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.usable).toEqual([keep]);
  });

  test("returns no usable rows for a stale repository", () => {
    const snap = issueSnapshot(
      [ownerRepoRow("widgets", { last_collected_at: TOO_OLD })],
      [issueRow()],
    );

    const judged = judgeGhOwnerIssueRepos("acme", snap, STALE_AFTER_MS);

    expect(judged.get("widgets")?.usable).toEqual([]);
  });
});

describe("usableTableRows", () => {
  function judgedOf(
    repos: readonly GhOwnerRepoFreshnessRow[],
    prs: readonly GhPullRequest[],
  ) {
    return judgeGhOwnerRepos("acme", snapshot(repos, prs), STALE_AFTER_MS);
  }

  test("orders the rows by repository and then by number", () => {
    const judged = judgedOf(
      [ownerRepoRow("widgets"), ownerRepoRow("gadgets")],
      [
        prRow({ id: 1, repo: "widgets", number: 2 }),
        prRow({ id: 2, repo: "gadgets", number: 9 }),
        prRow({ id: 3, repo: "widgets", number: 1 }),
      ],
    );
    expect(
      usableTableRows("acme", judged, () => true).map(
        (row) => `${row.repo}#${String(row.number)}`,
      ),
    ).toEqual(["gadgets#9", "widgets#1", "widgets#2"]);
  });

  test("leaves out the rows of a repository that is not allowed now", () => {
    const judged = judgedOf(
      [ownerRepoRow("widgets"), ownerRepoRow("secret")],
      [prRow({ repo: "widgets" }), prRow({ id: 2, repo: "secret" })],
    );
    expect(
      usableTableRows("acme", judged, (_owner, repo) => repo !== "secret").map(
        (row) => row.repo,
      ),
    ).toEqual(["widgets"]);
  });

  test("leaves out the rows of an archived repository", () => {
    const judged = judgedOf(
      [ownerRepoRow("widgets", { archived: true })],
      [prRow()],
    );
    expect(usableTableRows("acme", judged, () => true)).toEqual([]);
  });

  test("leaves out the rows of a repository that is gone", () => {
    const judged = judgedOf(
      [ownerRepoRow("widgets", { gone: true })],
      [prRow()],
    );
    expect(usableTableRows("acme", judged, () => true)).toEqual([]);
  });

  test("leaves out a row that is not usable", () => {
    const judged = judgedOf(
      [ownerRepoRow("widgets")],
      [prRow({ id: 1, number: 1 }), prRow({ id: 2, number: 2, usable: false })],
    );
    expect(
      usableTableRows("acme", judged, () => true).map((row) => row.number),
    ).toEqual([1]);
  });
});

// リポジトリ単位の古さを、所有者ごとに数える判定のテスト。
// 数える対象(明示でなく、gone・archivedでないリポジトリ)と、理由別の数え方、最初に見た時刻からの猶予を確かめる。
describe("gh_collect_read repo stale", () => {
  const MINUTE_MS = 60_000;
  const DAY_MS = 24 * 60 * MINUTE_MS;
  const DB_NOW = new Date("2026-10-19T00:00:00.000Z");
  /** 所有者が2人までの通知の閾値。 */
  const THRESHOLD_MS = 25 * MINUTE_MS;
  /** 所有者が2人までの、下流が記録を使う閾値。 */
  const SETTLED_MS = 15 * MINUTE_MS;
  const REPO_ID = 4242;
  const NO_REASONS: GhRepoStaleReasonCounts = {
    no_record: 0,
    unusable: 0,
    not_collected: 0,
    in_future: 0,
    too_old: 0,
  };

  function ago(ms: number): Date {
    return new Date(DB_NOW.getTime() - ms);
  }

  function repoRow(
    overrides: Partial<GhRepoFreshnessRow> = {},
  ): GhRepoFreshnessRow {
    return {
      repo_id: REPO_ID,
      allowed: true,
      archived: false,
      gone: false,
      last_collected_at: ago(5 * MINUTE_MS),
      truncated: false,
      detail_failed: false,
      ...overrides,
    };
  }

  function probe(overrides: Partial<GhRepoStaleProbe> = {}): GhRepoStaleProbe {
    return {
      owner: "acme",
      repo: "widgets",
      row: repoRow(),
      first_seen_at: ago(7 * DAY_MS),
      pr_open: false,
      pr_usable: false,
      issue_open: false,
      issue_usable: false,
      ...overrides,
    };
  }

  function summarize(
    probes: readonly GhRepoStaleProbe[],
    options: {
      owners?: readonly string[];
      isTarget?: (owner: string, repo: string) => boolean;
    } = {},
  ) {
    return summarizeRepoStale({
      snapshot: { db_now: DB_NOW, probes },
      owners: options.owners ?? ["acme"],
      staleAfterMs: THRESHOLD_MS,
      settledAfterMs: SETTLED_MS,
      isTarget: options.isTarget ?? (() => true),
    });
  }

  describe("summarizeRepoStale", () => {
    test("counts a fresh repository as a target that is not stale", () => {
      expect(summarize([probe()])).toEqual([
        {
          owner: "acme",
          targets: 1,
          stale: 0,
          pending: 0,
          unsettled: 0,
          reasons: NO_REASONS,
        },
      ]);
    });

    test("returns an entry for an owner without repositories", () => {
      expect(summarize([], { owners: ["acme"] })).toEqual([
        {
          owner: "acme",
          targets: 0,
          stale: 0,
          pending: 0,
          unsettled: 0,
          reasons: NO_REASONS,
        },
      ]);
    });

    test("ignores the repositories of other owners", () => {
      expect(summarize([probe({ owner: "other" })])[0]?.targets).toBe(0);
    });

    test("lowercases the owners it reports", () => {
      expect(summarize([probe()], { owners: ["Acme"] })[0]?.owner).toBe("acme");
    });
  });

  describe("summarizeRepoStale reasons", () => {
    test("reports no_record when the repository has no row", () => {
      expect(summarize([probe({ row: null })])[0]?.reasons.no_record).toBe(1);
    });

    test("reports unusable when the repository is not allowed", () => {
      const row = repoRow({ allowed: false });
      expect(summarize([probe({ row })])[0]?.reasons.unusable).toBe(1);
    });

    test("reports unusable when the repository has no numeric id", () => {
      const row = repoRow({ repo_id: null });
      expect(summarize([probe({ row })])[0]?.reasons.unusable).toBe(1);
    });

    test("reports not_collected when the details were never collected", () => {
      const row = repoRow({ last_collected_at: null });
      expect(summarize([probe({ row })])[0]?.reasons.not_collected).toBe(1);
    });

    test("reports in_future when the collection time is after the database time", () => {
      const row = repoRow({
        last_collected_at: new Date(DB_NOW.getTime() + 1),
      });
      expect(summarize([probe({ row })])[0]?.reasons.in_future).toBe(1);
    });

    test("reports too_old one millisecond past the threshold", () => {
      const row = repoRow({ last_collected_at: ago(THRESHOLD_MS + 1) });
      expect(summarize([probe({ row })])[0]?.reasons.too_old).toBe(1);
    });

    test("treats a collection exactly at the threshold as fresh", () => {
      const row = repoRow({ last_collected_at: ago(THRESHOLD_MS) });
      expect(summarize([probe({ row })])[0]?.stale).toBe(0);
    });

    test("judges by the notify threshold, not by the shorter downstream threshold", () => {
      const row = repoRow({ last_collected_at: ago(20 * MINUTE_MS) });
      expect(summarize([probe({ row })])[0]?.stale).toBe(0);
    });

    test("counts each reason in its own bucket", () => {
      const result = summarize([
        probe({ repo: "a", row: repoRow({ last_collected_at: null }) }),
        probe({ repo: "b", row: repoRow({ last_collected_at: null }) }),
        probe({ repo: "c", row: repoRow({ last_collected_at: ago(DAY_MS) }) }),
      ]);
      expect(result[0]?.reasons).toEqual({
        ...NO_REASONS,
        not_collected: 2,
        too_old: 1,
      });
    });

    test("reports unusable when every open pull request is unusable", () => {
      expect(
        summarize([probe({ pr_open: true, pr_usable: false })])[0]?.reasons
          .unusable,
      ).toBe(1);
    });

    test("reports unusable when every open issue is unusable", () => {
      expect(
        summarize([probe({ issue_open: true, issue_usable: false })])[0]
          ?.reasons.unusable,
      ).toBe(1);
    });

    test("stays fresh when some open pull request is usable", () => {
      expect(
        summarize([probe({ pr_open: true, pr_usable: true })])[0]?.stale,
      ).toBe(0);
    });

    test("is stale when the pull requests are unusable even if an issue is usable", () => {
      expect(
        summarize([
          probe({
            pr_open: true,
            pr_usable: false,
            issue_open: true,
            issue_usable: true,
          }),
        ])[0]?.stale,
      ).toBe(1);
    });

    test("is stale when the issues are unusable even if a pull request is usable", () => {
      expect(
        summarize([
          probe({
            pr_open: true,
            pr_usable: true,
            issue_open: true,
            issue_usable: false,
          }),
        ])[0]?.stale,
      ).toBe(1);
    });
  });

  describe("summarizeRepoStale unsettled", () => {
    const collectedAgo = (ms: number) =>
      probe({ row: repoRow({ last_collected_at: ago(ms) }) });

    test("counts nothing for a repository inside the downstream threshold", () => {
      expect(summarize([collectedAgo(10 * MINUTE_MS)])[0]?.unsettled).toBe(0);
    });

    test("treats a collection exactly at the downstream threshold as settled", () => {
      expect(summarize([collectedAgo(SETTLED_MS)])[0]?.unsettled).toBe(0);
    });

    test("counts a repository between the downstream and the notify threshold", () => {
      expect(summarize([collectedAgo(20 * MINUTE_MS)])[0]?.unsettled).toBe(1);
    });

    test("does not count a repository between the thresholds as stale", () => {
      expect(summarize([collectedAgo(20 * MINUTE_MS)])[0]?.stale).toBe(0);
    });

    test("counts a stale repository as unsettled", () => {
      expect(summarize([collectedAgo(DAY_MS)])[0]?.unsettled).toBe(1);
    });

    test("counts a repository within its grace as unsettled", () => {
      const first_seen_at = ago(MINUTE_MS);
      const row = repoRow({ last_collected_at: null });
      expect(summarize([probe({ row, first_seen_at })])[0]?.unsettled).toBe(1);
    });

    test("does not count a gone repository as unsettled", () => {
      const row = repoRow({ gone: true, last_collected_at: null });
      expect(summarize([probe({ row })])[0]?.unsettled).toBe(0);
    });
  });

  describe("summarizeRepoStale targets", () => {
    test("does not count a gone repository", () => {
      const row = repoRow({ gone: true, last_collected_at: null });
      expect(summarize([probe({ row })])[0]?.targets).toBe(0);
    });

    test("does not count an archived repository", () => {
      const row = repoRow({ archived: true, last_collected_at: null });
      expect(summarize([probe({ row })])[0]?.targets).toBe(0);
    });

    test("does not count a gone repository as stale", () => {
      const row = repoRow({ gone: true, last_collected_at: null });
      expect(summarize([probe({ row })])[0]?.stale).toBe(0);
    });

    test("does not count an explicit repository", () => {
      const row = repoRow({ last_collected_at: null });
      expect(
        summarize([probe({ row })], { isTarget: () => false })[0]?.targets,
      ).toBe(0);
    });

    test("asks the filter with the owner and the repository", () => {
      const asked: string[] = [];
      summarize([probe()], {
        isTarget: (owner, repo) => {
          asked.push(`${owner}/${repo}`);
          return true;
        },
      });
      expect(asked).toEqual(["acme/widgets"]);
    });

    test("counts a stale repository next to a fresh one", () => {
      const result = summarize([
        probe({ repo: "fresh" }),
        probe({ repo: "old", row: repoRow({ last_collected_at: null }) }),
      ]);
      expect([result[0]?.targets, result[0]?.stale]).toEqual([2, 1]);
    });
  });

  describe("summarizeRepoStale grace", () => {
    const NEVER_COLLECTED = repoRow({ last_collected_at: null });

    test("holds a new repository for the threshold from its first sight", () => {
      const first_seen_at = ago(THRESHOLD_MS - 1);
      const result = summarize([
        probe({ row: NEVER_COLLECTED, first_seen_at }),
      ]);
      expect([result[0]?.stale, result[0]?.pending]).toEqual([0, 1]);
    });

    test("still holds a repository exactly at the threshold from its first sight", () => {
      const first_seen_at = ago(THRESHOLD_MS);
      const result = summarize([
        probe({ row: NEVER_COLLECTED, first_seen_at }),
      ]);
      expect(result[0]?.pending).toBe(1);
    });

    test("counts a repository one millisecond past the grace", () => {
      const first_seen_at = ago(THRESHOLD_MS + 1);
      const result = summarize([
        probe({ row: NEVER_COLLECTED, first_seen_at }),
      ]);
      expect([result[0]?.stale, result[0]?.pending]).toEqual([1, 0]);
    });

    test("keeps the reason of a held repository out of the reasons", () => {
      const first_seen_at = ago(MINUTE_MS);
      const result = summarize([
        probe({ row: NEVER_COLLECTED, first_seen_at }),
      ]);
      expect(result[0]?.reasons).toEqual(NO_REASONS);
    });

    test("treats a first sight after the database time as within the grace", () => {
      const first_seen_at = new Date(DB_NOW.getTime() + MINUTE_MS);
      const result = summarize([
        probe({ row: NEVER_COLLECTED, first_seen_at }),
      ]);
      expect(result[0]?.pending).toBe(1);
    });

    test("does not hold a fresh repository", () => {
      const result = summarize([probe({ first_seen_at: ago(MINUTE_MS) })]);
      expect(result[0]?.pending).toBe(0);
    });
  });

  describe("repoStaleTargetFilter", () => {
    const BASE: Pick<
      FactoryConfig,
      "owners" | "repo_allowlist" | "factory_repo"
    > = {
      owners: [{ name: "acme", kind: "user" }],
      repo_allowlist: [],
      factory_repo: "https://github.com/acme/factory",
    };

    test("accepts a repository of a configured owner that is not explicit", () => {
      expect(repoStaleTargetFilter(BASE)("acme", "widgets")).toBe(true);
    });

    test("rejects the factory repository", () => {
      expect(repoStaleTargetFilter(BASE)("acme", "factory")).toBe(false);
    });

    test("rejects the factory repository regardless of case", () => {
      expect(repoStaleTargetFilter(BASE)("ACME", "Factory")).toBe(false);
    });

    test("rejects a repository of an owner that is not configured", () => {
      expect(repoStaleTargetFilter(BASE)("other", "widgets")).toBe(false);
    });

    test("rejects an allowlist entry", () => {
      const config = {
        ...BASE,
        repo_allowlist: ["https://github.com/acme/widgets"],
      };
      expect(repoStaleTargetFilter(config)("acme", "widgets")).toBe(false);
    });

    test("rejects every other repository once the allowlist is not empty", () => {
      const config = {
        ...BASE,
        repo_allowlist: ["https://github.com/acme/widgets"],
      };
      expect(repoStaleTargetFilter(config)("acme", "gadgets")).toBe(false);
    });
  });

  describe("nonExplicitReposPossible", () => {
    const BASE: Pick<
      FactoryConfig,
      "owners" | "repo_allowlist" | "factory_repo"
    > = {
      owners: [{ name: "acme", kind: "user" }],
      repo_allowlist: [],
      factory_repo: "https://github.com/acme/factory",
    };

    test("is true when owners are set and the allowlist is empty", () => {
      expect(nonExplicitReposPossible(BASE)).toBe(true);
    });

    test("is false once the allowlist is not empty", () => {
      const config = {
        ...BASE,
        repo_allowlist: ["https://github.com/acme/widgets"],
      };
      expect(nonExplicitReposPossible(config)).toBe(false);
    });

    test("is false when no owner is set", () => {
      expect(nonExplicitReposPossible({ ...BASE, owners: [] })).toBe(false);
    });

    test("agrees with whether a non-explicit repository is a stale target", () => {
      const config = {
        ...BASE,
        repo_allowlist: ["https://github.com/acme/widgets"],
      };
      expect(nonExplicitReposPossible(config)).toBe(
        repoStaleTargetFilter(config)("acme", "gadgets"),
      );
    });

    test("agrees with the stale target filter when the allowlist is empty", () => {
      expect(nonExplicitReposPossible(BASE)).toBe(
        repoStaleTargetFilter(BASE)("acme", "gadgets"),
      );
    });
  });
});
