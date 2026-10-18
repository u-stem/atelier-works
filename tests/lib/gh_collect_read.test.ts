// 収集の記録を下流が読んでよいかの判定のテスト。
// 鮮度の判定、判断を止める閾値、使ってよい行の絞り込みを確かめる。

import { describe, expect, test } from "bun:test";
import { staleNotifyThresholdMs } from "../../f/factory/lib/gh_collect_freshness.ts";
import {
  effectiveGhSource,
  ghDetailStaleAfterMs,
  judgeGhOwnerCoverage,
  judgeGhOwnerIssueRepos,
  judgeGhOwnerRepos,
  judgeGhRepoFreshness,
  requiredRepos,
  usableGhDetailRows,
  usableGhPullRequests,
  usableTableRows,
} from "../../f/factory/lib/gh_collect_read.ts";
import type {
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhRepoFreshnessRow,
} from "../../f/factory/lib/types.ts";

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

function judgeOwner(
  snap: GhOwnerOpenPrSnapshot,
  allowed: (owner: string, repo: string) => boolean = () => true,
  owner = "acme",
) {
  const judged = judgeGhOwnerRepos(owner, snap, STALE_AFTER_MS);
  return judgeGhOwnerCoverage(owner, judged, allowed);
}

const TOO_OLD = new Date(DB_NOW.getTime() - STALE_AFTER_MS - 1);

describe("judgeGhOwnerCoverage", () => {
  test("reports no_record when gh_repos has no row of the owner", () => {
    expect(judgeOwner(snapshot([]))).toEqual({
      kind: "stale",
      reason: "no_record",
    });
  });

  test("is fresh when every allowed repository is fresh", () => {
    const snap = snapshot([ownerRepoRow("widgets"), ownerRepoRow("gadgets")]);

    expect(judgeOwner(snap)).toEqual({ kind: "fresh" });
  });

  test("is stale with too_old when one allowed repository is too old", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { last_collected_at: TOO_OLD }),
    ]);

    expect(judgeOwner(snap)).toEqual({ kind: "stale", reason: "too_old" });
  });

  test("ignores a repository that is not allowed now even when it is too old", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { last_collected_at: TOO_OLD }),
    ]);

    expect(judgeOwner(snap, (_owner, repo) => repo !== "gadgets")).toEqual({
      kind: "fresh",
    });
  });

  test("ignores a gone repository", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { gone: true }),
    ]);

    expect(judgeOwner(snap)).toEqual({ kind: "fresh" });
  });

  test("ignores an archived repository", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { archived: true }),
    ]);

    expect(judgeOwner(snap)).toEqual({ kind: "fresh" });
  });

  test("reports unusable for a repository allowed now but recorded as not allowed", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { allowed: false }),
    ]);

    expect(judgeOwner(snap)).toEqual({ kind: "stale", reason: "unusable" });
  });

  test("reports unusable when every open row of a repository is unusable", () => {
    const snap = snapshot(
      [ownerRepoRow("widgets")],
      [prRow({ repo: "widgets", usable: false })],
    );

    expect(judgeOwner(snap)).toEqual({ kind: "stale", reason: "unusable" });
  });

  test("takes the reason of the first stale repository in name order", () => {
    const snap = snapshot([
      ownerRepoRow("zeta", { last_collected_at: null }),
      ownerRepoRow("alpha", { last_collected_at: TOO_OLD }),
    ]);

    expect(judgeOwner(snap)).toEqual({ kind: "stale", reason: "too_old" });
  });

  test("is fresh when no repository is allowed now", () => {
    const snap = snapshot([
      ownerRepoRow("widgets", { last_collected_at: null }),
    ]);

    expect(judgeOwner(snap, () => false)).toEqual({ kind: "fresh" });
  });

  test("passes the stored owner and repository names to the allowed check", () => {
    const seen: string[] = [];
    const snap = snapshot([ownerRepoRow("widgets")]);

    judgeOwner(
      snap,
      (owner, repo) => {
        seen.push(`${owner}/${repo}`);
        return true;
      },
      "Acme",
    );

    expect(seen).toEqual(["Acme/widgets"]);
  });
});

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

describe("effectiveGhSource", () => {
  const ENABLED = { gh_collect_enabled: true, gh_collect_detail_enabled: true };

  test("is db when the setting is db and both collection settings are on", () => {
    expect(effectiveGhSource("db", ENABLED)).toBe("db");
  });

  test("is search when gh_collect_enabled is off", () => {
    expect(
      effectiveGhSource("db", { ...ENABLED, gh_collect_enabled: false }),
    ).toBe("search");
  });

  test("is search when gh_collect_detail_enabled is off", () => {
    expect(
      effectiveGhSource("db", { ...ENABLED, gh_collect_detail_enabled: false }),
    ).toBe("search");
  });

  test("is search when the setting is search", () => {
    expect(effectiveGhSource("search", ENABLED)).toBe("search");
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

describe("judgeGhOwnerCoverage with required repositories", () => {
  function judgeRequired(
    repos: readonly GhOwnerRepoFreshnessRow[],
    required: ReadonlySet<string>,
    allowed: (owner: string, repo: string) => boolean = () => true,
  ) {
    const judged = judgeGhOwnerIssueRepos(
      "acme",
      issueSnapshot(repos),
      STALE_AFTER_MS,
    );
    return judgeGhOwnerCoverage("acme", judged, allowed, required);
  }

  test("reports no_record when a required repository has no gh_repos row", () => {
    expect(
      judgeRequired([ownerRepoRow("widgets")], new Set(["gadgets"])),
    ).toEqual({ kind: "stale", reason: "no_record" });
  });

  test("reports unusable for a required repository that is not listed or not visible", () => {
    expect(
      judgeRequired(
        [ownerRepoRow("widgets"), ownerRepoRow("gadgets", { gone: true })],
        new Set(["gadgets"]),
      ),
    ).toEqual({ kind: "stale", reason: "unusable" });
  });

  test("ignores an archived repository even when it is required", () => {
    expect(
      judgeRequired(
        [
          ownerRepoRow("widgets"),
          ownerRepoRow("gadgets", { gone: true, archived: true }),
        ],
        new Set(["gadgets"]),
      ),
    ).toEqual({ kind: "fresh" });
  });

  test("ignores a gone repository that is not required", () => {
    expect(
      judgeRequired(
        [ownerRepoRow("widgets"), ownerRepoRow("gadgets", { gone: true })],
        new Set(["widgets"]),
      ),
    ).toEqual({ kind: "fresh" });
  });

  test("matches required names without regard to case", () => {
    expect(
      judgeRequired([ownerRepoRow("widgets")], new Set(["Widgets"])),
    ).toEqual({ kind: "fresh" });
  });

  test("ignores a required repository that is not allowed now", () => {
    expect(
      judgeRequired(
        [
          ownerRepoRow("widgets"),
          ownerRepoRow("gadgets", { last_collected_at: TOO_OLD }),
        ],
        new Set(["gadgets"]),
        (_owner, repo) => repo !== "gadgets",
      ),
    ).toEqual({ kind: "fresh" });
  });

  test("gives the same result as before when required is omitted", () => {
    const snap = snapshot([
      ownerRepoRow("widgets"),
      ownerRepoRow("gadgets", { gone: true }),
    ]);
    const judged = judgeGhOwnerRepos("acme", snap, STALE_AFTER_MS);

    expect(judgeGhOwnerCoverage("acme", judged, () => true)).toEqual({
      kind: "fresh",
    });
  });
});

describe("requiredRepos", () => {
  const SCOPE = {
    factory_repo: "https://github.com/Acme/Factory.git",
    repo_allowlist: [
      "https://github.com/acme/Widgets",
      "https://github.com/other/tools",
    ],
  };

  test("lists the factory repository and the allowlist entries of the owner in lower case", () => {
    expect([...requiredRepos(SCOPE, "acme")].sort()).toEqual([
      "factory",
      "widgets",
    ]);
  });

  test("leaves out the entries of other owners", () => {
    expect([...requiredRepos(SCOPE, "other")]).toEqual(["tools"]);
  });

  test("compares the owner without regard to case", () => {
    expect([...requiredRepos(SCOPE, "ACME")].sort()).toEqual([
      "factory",
      "widgets",
    ]);
  });

  test("skips an entry that cannot be read", () => {
    const scope = { ...SCOPE, repo_allowlist: ["not a url"] };
    expect([...requiredRepos(scope, "acme")]).toEqual(["factory"]);
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
