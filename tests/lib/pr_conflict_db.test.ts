import { describe, expect, test } from "bun:test";
import {
  deletePrConflictChecksBefore,
  listConflictedPrConflictChecks,
  listPrConflictRepos,
  listPrOpenRepos,
  markPrConflictNotified,
  recordPrConflict,
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
