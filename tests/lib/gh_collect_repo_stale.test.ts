// リポジトリ単位の古さを、所有者ごとに数える判定のテスト。
// 数える対象(明示でなく、gone・archivedでないリポジトリ)と、理由別の数え方、最初に見た時刻からの猶予を確かめる。

import { describe, expect, test } from "bun:test";
import {
  nonExplicitReposPossible,
  repoStaleTargetFilter,
  summarizeRepoStale,
} from "../../f/factory/lib/gh_collect_read.ts";
import type {
  FactoryConfig,
  GhRepoFreshnessRow,
  GhRepoStaleProbe,
  GhRepoStaleReasonCounts,
} from "../../f/factory/lib/types.ts";

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
    const row = repoRow({ last_collected_at: new Date(DB_NOW.getTime() + 1) });
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
      summarize([probe({ issue_open: true, issue_usable: false })])[0]?.reasons
        .unusable,
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
    const result = summarize([probe({ row: NEVER_COLLECTED, first_seen_at })]);
    expect([result[0]?.stale, result[0]?.pending]).toEqual([0, 1]);
  });

  test("still holds a repository exactly at the threshold from its first sight", () => {
    const first_seen_at = ago(THRESHOLD_MS);
    const result = summarize([probe({ row: NEVER_COLLECTED, first_seen_at })]);
    expect(result[0]?.pending).toBe(1);
  });

  test("counts a repository one millisecond past the grace", () => {
    const first_seen_at = ago(THRESHOLD_MS + 1);
    const result = summarize([probe({ row: NEVER_COLLECTED, first_seen_at })]);
    expect([result[0]?.stale, result[0]?.pending]).toEqual([1, 0]);
  });

  test("keeps the reason of a held repository out of the reasons", () => {
    const first_seen_at = ago(MINUTE_MS);
    const result = summarize([probe({ row: NEVER_COLLECTED, first_seen_at })]);
    expect(result[0]?.reasons).toEqual(NO_REASONS);
  });

  test("treats a first sight after the database time as within the grace", () => {
    const first_seen_at = new Date(DB_NOW.getTime() + MINUTE_MS);
    const result = summarize([probe({ row: NEVER_COLLECTED, first_seen_at })]);
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
