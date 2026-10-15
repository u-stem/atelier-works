import { describe, expect, test } from "bun:test";
import {
  deletePrConflictChecksBefore,
  getPrConflictCheck,
  listConflictedPrConflictChecks,
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
const BASE = "b".repeat(40);

const ROW: SqlRow = {
  id: "7",
  owner: "acme",
  repo: "widgets",
  pr_number: 12,
  head_sha: HEAD,
  base_sha: BASE,
  state: "conflicted",
  fix_attempts: 0,
  notified_at: null,
  checked_at: new Date("2026-10-15T00:00:00.000Z"),
  created_at: new Date("2026-10-15T00:00:00.000Z"),
  updated_at: new Date("2026-10-15T00:00:00.000Z"),
};

const OBSERVATION = {
  owner: "Acme",
  repo: "Widgets",
  pr_number: 12,
  head_sha: HEAD,
  base_sha: BASE,
};

describe("recordPrConflict", () => {
  test("returns the parsed row", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);
    expect(await recordPrConflict(OBSERVATION, sql)).toMatchObject({
      id: 7,
      owner: "acme",
      pr_number: 12,
      head_sha: HEAD,
      base_sha: BASE,
      state: "conflicted",
      notified_at: null,
    });
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

  test("keeps the notified time only when the state, head and base are unchanged", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict(OBSERVATION, sql);
    expect(calls[0]?.text).toMatch(
      /notified_at = CASE\s+WHEN c\.state = 'conflicted'\s+AND c\.head_sha = EXCLUDED\.head_sha\s+AND c\.base_sha = EXCLUDED\.base_sha\s+THEN c\.notified_at\s+ELSE NULL\s+END/,
    );
  });

  test("rejects a head sha that is not a full commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict({ ...OBSERVATION, head_sha: "abc123" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a base sha that is not a full commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await recordPrConflict({ ...OBSERVATION, base_sha: "abc123" }, sql).catch(
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

describe("getPrConflictCheck", () => {
  test("returns null when the pull request has no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getPrConflictCheck("acme", "widgets", 12, sql)).toBeNull();
  });

  test("parses the notified time", async () => {
    const notifiedAt = new Date("2026-10-15T01:00:00.000Z");
    const { sql } = createFakeSqlClient([
      [{ ...ROW, notified_at: notifiedAt }],
    ]);
    const row = await getPrConflictCheck("acme", "widgets", 12, sql);
    expect(row?.notified_at).toEqual(notifiedAt);
  });

  test("lowercases the owner and repo", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPrConflictCheck("Acme", "Widgets", 12, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });
});

describe("markPrConflictNotified", () => {
  test("writes only for the head and base that were notified", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await markPrConflictNotified(7, HEAD, BASE, sql);
    expect(calls[0]?.text).toMatch(
      /head_sha =\s+\?\s+AND base_sha =\s+\?\s+AND state = 'conflicted'\s+AND notified_at IS NULL/,
    );
  });

  test("returns true when the time was newly written", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    expect(await markPrConflictNotified(7, HEAD, BASE, sql)).toBe(true);
  });

  test("returns false when the row changed or was already notified", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await markPrConflictNotified(7, HEAD, BASE, sql)).toBe(false);
  });

  test("rejects a sha that is not a full commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await markPrConflictNotified(7, "abc", BASE, sql).catch(() => undefined);
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
