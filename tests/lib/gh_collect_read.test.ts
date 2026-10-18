// 収集の記録を下流が読んでよいかの判定のテスト。
// 鮮度の判定、判断を止める閾値、使ってよい行の絞り込みを確かめる。

import { describe, expect, test } from "bun:test";
import { staleNotifyThresholdMs } from "../../f/factory/lib/gh_collect_freshness.ts";
import {
  ghDetailStaleAfterMs,
  judgeGhRepoFreshness,
  usableGhPullRequests,
} from "../../f/factory/lib/gh_collect_read.ts";
import type {
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
