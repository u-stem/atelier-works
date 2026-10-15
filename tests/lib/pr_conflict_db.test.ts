import { describe, expect, test } from "bun:test";
import {
  claimPrConflictForFix,
  countPrConflictFixRounds,
  deletePrConflictChecksBefore,
  listConflictedPrConflictChecks,
  listPrConflictFixing,
  listPrConflictRepos,
  listPrOpenRepos,
  markPrConflictNotified,
  recordPrConflict,
  releasePrConflictFix,
  setPrConflictFixHold,
  settlePrConflictCheck,
  touchPrConflictCheck,
} from "../../f/factory/lib/db.ts";

type SqlRow = Record<string, unknown>;
type FakeCall = { text: string; values: unknown[] };

type FakeSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => { fetch: () => Promise<SqlRow[]>; execute: () => Promise<void> };

/** 呼び出しを記録し、呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。 */
function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: FakeSql;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: FakeSql = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const HEAD = "a".repeat(40);

const ROW: SqlRow = {
  id: "7",
  owner: "acme",
  repo: "widgets",
  pr_number: 12,
  head_sha: HEAD,
  state: "conflicted",
  episode: 1,
  notified_at: null,
  fix_work_item_id: null,
  fix_attempts: 0,
  fix_hold_reason: null,
  episode_started_at: new Date("2026-10-15T00:00:00.000Z"),
  checked_at: new Date("2026-10-15T00:00:00.000Z"),
  created_at: new Date("2026-10-15T00:00:00.000Z"),
  updated_at: new Date("2026-10-15T00:00:00.000Z"),
  prior_state: null,
};

const OBSERVATION = {
  owner: "Acme",
  repo: "Widgets",
  pr_number: 12,
  head_sha: HEAD,
};

describe("recordPrConflict", () => {
  test("returns the parsed row", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);
    expect((await recordPrConflict(OBSERVATION, sql)).row).toMatchObject({
      id: 7,
      owner: "acme",
      pr_number: 12,
      head_sha: HEAD,
      state: "conflicted",
      notified_at: null,
    });
  });

  test("reports a started conflict when the pull request had no row", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, prior_state: null }]]);
    expect((await recordPrConflict(OBSERVATION, sql)).started).toBe(true);
  });

  test("reports a started conflict when the row was resolved", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...ROW, prior_state: "resolved" }],
    ]);
    expect((await recordPrConflict(OBSERVATION, sql)).started).toBe(true);
  });

  test("reports a started conflict when the row was closed", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, prior_state: "closed" }]]);
    expect((await recordPrConflict(OBSERVATION, sql)).started).toBe(true);
  });

  test("reports a continuing conflict when the row was already conflicted", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...ROW, prior_state: "conflicted" }],
    ]);
    expect((await recordPrConflict(OBSERVATION, sql)).started).toBe(false);
  });

  test("returns the episode of the conflict", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, episode: "3" }]]);
    expect((await recordPrConflict(OBSERVATION, sql)).row.episode).toBe(3);
  });

  test("counts up the episode only when a conflict starts again", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).toContain(
      "episode = CASE WHEN c.state = 'conflicted' THEN c.episode ELSE c.episode + 1 END",
    );
  });

  test("lowercases the owner and repo", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });

  test("updates the existing row of the pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (owner, repo, pr_number) DO UPDATE",
    );
  });

  test("keeps the notified time only while the row stays conflicted", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).toContain(
      "notified_at = CASE WHEN c.state = 'conflicted' THEN c.notified_at ELSE NULL END",
    );
  });

  test("overwrites the head without clearing the notified time", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).toContain("head_sha = EXCLUDED.head_sha");
  });

  test("does not touch a base commit", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).not.toContain("base_sha");
  });

  test("rejects a head sha that is not a full commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict({ ...OBSERVATION, head_sha: "abc123" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an owner that is not a GitHub name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict({ ...OBSERVATION, owner: "a b" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a pull request number that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict({ ...OBSERVATION, pr_number: 0 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a row with an unexpected state", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, state: "other" }]]);
    await expect(recordPrConflict(OBSERVATION, sql)).rejects.toThrow(
      "unexpected value",
    );
  });

  test("fails when the database returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(recordPrConflict(OBSERVATION, sql)).rejects.toThrow(
      "recordPrConflict",
    );
  });
});

describe("markPrConflictNotified", () => {
  test("writes only for a conflicted row that was not notified", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await markPrConflictNotified(7, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE id =\s+\?\s*::bigint AND state = 'conflicted' AND notified_at IS NULL/,
    );
  });

  test("reports that the time was newly written", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    expect(await markPrConflictNotified(7, sql)).toBe("marked");
  });

  test("does not read the state again when the time was newly written", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await markPrConflictNotified(7, sql);
    expect(calls).toHaveLength(1);
  });

  test("reads the state in a separate statement when nothing was written", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ state: "conflicted" }]]);
    await markPrConflictNotified(7, sql);
    expect(calls).toHaveLength(2);
  });

  test("reads the state of the same row", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ state: "conflicted" }]]);
    await markPrConflictNotified(7, sql);
    expect(calls[1]?.text).toMatch(
      /SELECT state FROM factory\.pr_conflict_checks\s+WHERE id =/,
    );
  });

  test("reports that another run had already recorded the notification", async () => {
    const { sql } = createFakeSqlClient([[], [{ state: "conflicted" }]]);
    expect(await markPrConflictNotified(7, sql)).toBe("already_notified");
  });

  test("reports that the row is no longer conflicted when it was resolved", async () => {
    const { sql } = createFakeSqlClient([[], [{ state: "resolved" }]]);
    expect(await markPrConflictNotified(7, sql)).toBe("not_conflicted");
  });

  test("reports that the row is no longer conflicted when it was closed", async () => {
    const { sql } = createFakeSqlClient([[], [{ state: "closed" }]]);
    expect(await markPrConflictNotified(7, sql)).toBe("not_conflicted");
  });

  test("reports that the row is no longer conflicted when it is gone", async () => {
    const { sql } = createFakeSqlClient([[], []]);
    expect(await markPrConflictNotified(7, sql)).toBe("not_conflicted");
  });

  test("rejects an id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await markPrConflictNotified(0, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("settlePrConflictCheck", () => {
  test("moves a row that is not already in the target state", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await settlePrConflictCheck(7, "resolved", sql);
    expect(calls[0]?.text).toContain("state <>");
  });

  test("returns true when the row moved", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    expect(await settlePrConflictCheck(7, "closed", sql)).toBe(true);
  });

  test("returns false when the row was already in the state", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await settlePrConflictCheck(7, "closed", sql)).toBe(false);
  });
});

describe("touchPrConflictCheck", () => {
  test("advances only the last check time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await touchPrConflictCheck(7, sql);
    expect(calls[0]?.text).toMatch(/SET checked_at = now\(\)\s+WHERE id =/);
  });
});

describe("listConflictedPrConflictChecks", () => {
  test("lists the conflicted rows, least recently checked first", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await listConflictedPrConflictChecks(10, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE state = 'conflicted'\s+ORDER BY checked_at ASC, id ASC\s+LIMIT/,
    );
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);
    const rows = await listConflictedPrConflictChecks(10, sql);
    expect(rows[0]?.id).toBe(7);
  });
});

describe("deletePrConflictChecksBefore", () => {
  const cutoff = new Date("2026-09-12T00:00:00.000Z");

  test("keeps the rows that are still conflicted", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrConflictChecksBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("state <> 'conflicted'");
  });

  test("ages a row by its updated_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrConflictChecksBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("updated_at <=");
  });

  test("binds the cutoff as a timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrConflictChecksBefore(cutoff, sql);
    expect(calls[0]?.values).toEqual([cutoff.toISOString()]);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await deletePrConflictChecksBefore(cutoff, sql)).toBe(2);
  });
});

describe("listPrOpenRepos", () => {
  test("lists each repository of the pr_open issue items once", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrOpenRepos(sql);
    expect(calls[0]?.text).toMatch(
      /SELECT DISTINCT owner, repo FROM factory\.work_items\s+WHERE kind = 'issue' AND status = 'pr_open' AND pr_url IS NOT NULL/,
    );
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[{ owner: "acme", repo: "widgets" }]]);
    expect(await listPrOpenRepos(sql)).toEqual([
      { owner: "acme", repo: "widgets" },
    ]);
  });
});

describe("listPrConflictRepos", () => {
  test("lists each repository of the conflict rows once, whatever the state", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrConflictRepos(sql);
    expect(calls[0]?.text).toMatch(
      /SELECT DISTINCT owner, repo FROM factory\.pr_conflict_checks/,
    );
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[{ owner: "acme", repo: "widgets" }]]);
    expect(await listPrConflictRepos(sql)).toEqual([
      { owner: "acme", repo: "widgets" },
    ]);
  });
});

describe("recordPrConflict: the fix columns", () => {
  test("does not write the fix work item id", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).not.toContain("fix_work_item_id =");
  });

  test("returns the fix columns of the row", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...ROW,
          fix_work_item_id: "31",
          fix_attempts: "2",
          fix_hold_reason: "recently_fixed",
        },
      ],
    ]);
    expect((await recordPrConflict(OBSERVATION, sql)).row).toMatchObject({
      fix_work_item_id: 31,
      fix_attempts: 2,
      fix_hold_reason: "recently_fixed",
    });
  });

  test("returns the start time of the episode", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);
    expect(
      (await recordPrConflict(OBSERVATION, sql)).row.episode_started_at,
    ).toEqual(new Date("2026-10-15T00:00:00.000Z"));
  });

  test("rejects a row whose fix attempts are not a number", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, fix_attempts: "x" }]]);
    await expect(recordPrConflict(OBSERVATION, sql)).rejects.toThrow(
      "fix_attempts",
    );
  });

  test("rejects a row whose fix hold reason is empty", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, fix_hold_reason: "" }]]);
    await expect(recordPrConflict(OBSERVATION, sql)).rejects.toThrow(
      "fix_hold_reason",
    );
  });
});

const CLAIM_INPUT = {
  id: 7,
  owner: "Acme",
  repo: "Widgets",
  headSha: HEAD,
  title: "t",
  claimedBy: "bot",
};

describe("claimPrConflictForFix", () => {
  test("returns the id of the new work item", async () => {
    const { sql } = createFakeSqlClient([[{ id: "41" }]]);
    expect(await claimPrConflictForFix(CLAIM_INPUT, sql)).toBe(41);
  });

  test("returns null when no row was claimed", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await claimPrConflictForFix(CLAIM_INPUT, sql)).toBeNull();
  });

  test("claims with one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "41" }]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls).toHaveLength(1);
  });

  test("returns null when the active pr_fix index rejects the insert", async () => {
    const sql = () => ({
      fetch: () =>
        Promise.reject(
          new Error(
            'duplicate key value violates unique constraint "work_items_active_pr_fix_key"',
          ),
        ),
      execute: () => Promise.resolve(),
    });
    expect(await claimPrConflictForFix(CLAIM_INPUT, sql)).toBeNull();
  });

  test("rethrows another database error", async () => {
    const sql = () => ({
      fetch: () => Promise.reject(new Error("db down")),
      execute: () => Promise.resolve(),
    });
    await expect(claimPrConflictForFix(CLAIM_INPUT, sql)).rejects.toThrow(
      "db down",
    );
  });

  test("claims only a conflicted row of the observed head", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toMatch(
      /r\.state = 'conflicted' AND r\.head_sha =\s+\?/,
    );
  });

  test("claims only a row that is not notified and has no fix work item", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain(
      "r.fix_work_item_id IS NULL AND r.notified_at IS NULL",
    );
  });

  test("refuses a row with a final hold", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain("r.fix_hold_reason IS NULL OR");
  });

  test("passes only the temporary reasons as the holds that may be claimed", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.values).toContainEqual([
      "last_fix_unsettled",
      "budget_exceeded",
      "recently_fixed",
      "marker_missing",
      "main_ci_failed",
    ]);
  });

  test("clears the hold of the claimed row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain("fix_hold_reason = NULL");
  });

  test("counts the attempt of the row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain("fix_attempts = r.fix_attempts + 1");
  });

  test("leaves the state of the row as conflicted", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).not.toContain("SET state");
  });

  test("refuses a pull request that has an active pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain("active.kind = 'pr_fix'");
  });

  test("copies the round and the watermarks from the latest pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain(
      "COALESCE((SELECT last_review_comment_id FROM prev), 0)",
    );
  });

  test("ties the work item to the row and the episode, not to a CI check", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.text).toContain(
      "head_sha, conflict_check_id, conflict_episode,",
    );
  });

  test("lowercases the owner and repo for the row, and keeps the spelling for the work item", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await claimPrConflictForFix(CLAIM_INPUT, sql);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["acme", "widgets", "Acme", "Widgets"]),
    );
  });

  test("rejects an id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "41" }]]);
    await claimPrConflictForFix({ ...CLAIM_INPUT, id: 0 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a head sha that is not a full commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "41" }]]);
    await claimPrConflictForFix({ ...CLAIM_INPUT, headSha: "abc" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an owner that is not a GitHub name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "41" }]]);
    await claimPrConflictForFix({ ...CLAIM_INPUT, owner: "a b" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("setPrConflictFixHold", () => {
  test("writes only to a conflicted row that has no fix work item", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, "main_ci_failed", {}, sql);
    expect(calls[0]?.text).toContain(
      "state = 'conflicted' AND fix_work_item_id IS NULL",
    );
  });

  test("writes only when the reason changes", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, "main_ci_failed", {}, sql);
    expect(calls[0]?.text).toContain("fix_hold_reason IS DISTINCT FROM");
  });

  test("returns true when it wrote", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    expect(await setPrConflictFixHold(7, "main_ci_failed", {}, sql)).toBe(true);
  });

  test("returns false when nothing changed", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await setPrConflictFixHold(7, "main_ci_failed", {}, sql)).toBe(
      false,
    );
  });

  test("clears the hold with null", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, null, {}, sql);
    expect(calls[0]?.values).toContain(null);
  });

  test("compares with the expected reason only when it is passed", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, "main_ci_failed", { expected: null }, sql);
    expect(calls[0]?.values).toContain(true);
  });

  test("rejects an empty reason, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, "", {}, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a reason longer than 64 characters, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(7, "x".repeat(65), {}, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await setPrConflictFixHold(0, null, {}, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("releasePrConflictFix", () => {
  test("unbinds only a row that has a fix work item", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, {}, sql);
    expect(calls[0]?.text).toContain("fix_work_item_id IS NOT NULL");
  });

  test("clears the fix work item id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, {}, sql);
    expect(calls[0]?.text).toContain("SET fix_work_item_id = NULL");
  });

  test("does not require the row to be conflicted", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, {}, sql);
    expect(calls[0]?.text).not.toContain("state = 'conflicted'");
  });

  test("keeps the current hold when no reason is passed", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, {}, sql);
    expect(calls[0]?.text).toContain("fix_hold_reason = COALESCE(");
  });

  test("returns true when it unbound the row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    expect(await releasePrConflictFix(7, {}, sql)).toBe(true);
  });

  test("returns false when the row was not bound", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await releasePrConflictFix(7, {}, sql)).toBe(false);
  });

  test("rejects an empty hold reason, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, { holdReason: "" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a work item id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await releasePrConflictFix(7, { fixWorkItemId: 0 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("listPrConflictFixing", () => {
  test("lists the rows that have a fix work item, least recently checked first", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await listPrConflictFixing(10, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE fix_work_item_id IS NOT NULL\s+ORDER BY checked_at ASC, id ASC\s+LIMIT/,
    );
  });

  test("does not filter by state", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await listPrConflictFixing(10, sql);
    expect(calls[0]?.text).not.toContain("state =");
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, fix_work_item_id: "31" }]]);
    expect((await listPrConflictFixing(10, sql))[0]?.fix_work_item_id).toBe(31);
  });
});

describe("countPrConflictFixRounds", () => {
  const EPISODE = { kind: "episode", checkId: 7, episode: 2 } as const;
  const PR = {
    kind: "pr",
    owner: "Acme",
    repo: "Widgets",
    prNumber: 12,
  } as const;

  test("returns the count", async () => {
    const { sql } = createFakeSqlClient([[{ rounds: "3" }]]);
    expect(await countPrConflictFixRounds(EPISODE, sql)).toBe(3);
  });

  test("returns zero when no row comes back", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await countPrConflictFixRounds(EPISODE, sql)).toBe(0);
  });

  test("counts the episode by the check id and the episode", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(EPISODE, sql);
    expect(calls[0]?.text).toMatch(
      /wi\.conflict_check_id =\s+\?\s*::bigint AND wi\.conflict_episode =\s+\?\s*::integer/,
    );
  });

  test("counts the pull request from the work items, not through the conflict rows", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(PR, sql);
    expect(calls[0]?.text).not.toContain("pr_conflict_checks");
  });

  test("counts the pull request by the lower-case owner and repo", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(PR, sql);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["acme", "widgets"]),
    );
  });

  test("counts only conflict rounds of pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(PR, sql);
    expect(calls[0]?.text).toContain(
      "wi.kind = 'pr_fix' AND wi.conflict_check_id IS NOT NULL",
    );
  });

  test("does not count a failed work item that never started a flow", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(EPISODE, sql);
    expect(calls[0]?.text).toContain(
      "NOT (wi.status = 'failed' AND wi.flow_job_id IS NULL)",
    );
  });

  test("does not count a round that ended up to date", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(EPISODE, sql);
    expect(calls[0]?.values).toContain("conflict round: up_to_date");
  });

  test("tells an up to date round by the reviewed status and the note", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds(EPISODE, sql);
    expect(calls[0]?.text).toContain("wi.status = 'reviewed'");
  });

  test("rejects an episode check id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds({ ...EPISODE, checkId: 0 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an owner that is not a GitHub name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrConflictFixRounds({ ...PR, owner: "a b" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});
