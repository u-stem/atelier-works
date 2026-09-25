import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  computeYesterdayRangeJst,
  getAgentRunSummary,
  getApprovalSummary,
} from "../../f/factory/lib/summary_support.ts";

type FakeCall = { text: string; values: unknown[] };

/** Same fake-SqlClient shape as tests/lib/db.test.ts: records every
 * tagged-template call and returns one canned row set per call, in order. */
function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings, ...values) => {
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

describe("computeYesterdayRangeJst", () => {
  test("labels the JST calendar day before `now`'s JST calendar day", () => {
    // 2026-09-26T00:05:00Z is 2026-09-26 09:05 JST.
    const range = computeYesterdayRangeJst(new Date("2026-09-26T00:05:00Z"));
    expect(range.label).toBe("2026-09-25");
  });

  test("start is yesterday's 00:00 JST expressed in real UTC", () => {
    const range = computeYesterdayRangeJst(new Date("2026-09-26T00:05:00Z"));
    expect(range.start.toISOString()).toBe("2026-09-24T15:00:00.000Z");
  });

  test("end is today's 00:00 JST expressed in real UTC", () => {
    const range = computeYesterdayRangeJst(new Date("2026-09-26T00:05:00Z"));
    expect(range.end.toISOString()).toBe("2026-09-25T15:00:00.000Z");
  });

  test("a `now` just before JST midnight still resolves to the same JST day", () => {
    // 2026-09-26T14:59:59Z is 2026-09-26 23:59:59 JST (not yet the 27th).
    const range = computeYesterdayRangeJst(new Date("2026-09-26T14:59:59Z"));
    expect(range.label).toBe("2026-09-25");
  });
});

const RANGE = computeYesterdayRangeJst(new Date("2026-09-26T00:05:00Z"));

describe("getAgentRunSummary", () => {
  test("queries factory.agent_runs", async () => {
    const { sql, calls } = createFakeSqlClient([
      [{ run_count: 3, total_cost_usd: "1.2500", failure_count: 1 }],
    ]);
    await getAgentRunSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("FROM factory.agent_runs");
  });

  test("parses a numeric-string total_cost_usd (Postgres numeric column)", async () => {
    const { sql } = createFakeSqlClient([
      [{ run_count: 3, total_cost_usd: "1.2500", failure_count: 1 }],
    ]);
    const summary = await getAgentRunSummary(RANGE, sql);
    expect(summary.total_cost_usd).toBe(1.25);
  });

  test("parses run_count and failure_count", async () => {
    const { sql } = createFakeSqlClient([
      [{ run_count: 3, total_cost_usd: "1.2500", failure_count: 1 }],
    ]);
    const summary = await getAgentRunSummary(RANGE, sql);
    expect([summary.run_count, summary.failure_count]).toEqual([3, 1]);
  });

  test("returns zeros when the query returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const summary = await getAgentRunSummary(RANGE, sql);
    expect(summary).toEqual({
      run_count: 0,
      total_cost_usd: 0,
      failure_count: 0,
    });
  });
});

describe("getApprovalSummary", () => {
  test("queries factory.approvals", async () => {
    const { sql, calls } = createFakeSqlClient([
      [{ approved_count: 2, rejected_count: 1 }],
    ]);
    await getApprovalSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("FROM factory.approvals");
  });

  test("parses approved_count and rejected_count", async () => {
    const { sql } = createFakeSqlClient([
      [{ approved_count: 2, rejected_count: 1 }],
    ]);
    const summary = await getApprovalSummary(RANGE, sql);
    expect(summary).toEqual({ approved_count: 2, rejected_count: 1 });
  });

  test("returns zeros when the query returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const summary = await getApprovalSummary(RANGE, sql);
    expect(summary).toEqual({ approved_count: 0, rejected_count: 0 });
  });
});
