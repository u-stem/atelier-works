import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  computeYesterdayRangeJst,
  getAgentRunSummary,
  getApprovalSummary,
  getCleanupSummary,
} from "../../f/factory/lib/summary_support.ts";

type FakeCall = { text: string; values: unknown[] };

/**
 * タグ付きテンプレートの呼び出しをすべて記録し、
 * 呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。
 * 形は`tests/lib/db.test.ts`と同じ。
 */
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
    // 2026-09-26T00:05:00ZはJSTで2026-09-26 09:05。
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
    // 2026-09-26T14:59:59ZはJSTで2026-09-26 23:59:59(まだ27日ではない)。
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
  test("queries factory.approval_requests", async () => {
    const { sql, calls } = createFakeSqlClient([
      [{ approved_count: 2, rejected_count: 1 }],
    ]);
    await getApprovalSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("FROM factory.approval_requests");
  });

  test("counts only requirement-draft decisions (kind = requirements)", async () => {
    const { sql, calls } = createFakeSqlClient([
      [{ approved_count: "0", rejected_count: "0" }],
    ]);
    await getApprovalSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("kind = 'requirements'");
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

describe("getCleanupSummary", () => {
  test("queries factory.cleanup_runs", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          run_count: 1,
          work_items_deleted: 3,
          approval_requests_deleted: 5,
          job_failures_deleted: 12,
          deployments_deleted: 5,
          notices_deleted: 2,
          info_notices_resolved: 0,
          doc_dirs_deleted: 0,
        },
      ],
    ]);
    await getCleanupSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("FROM factory.cleanup_runs");
  });

  test("sums the sweep counts when a run exists in range", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          run_count: 1,
          work_items_deleted: "3",
          approval_requests_deleted: "5",
          job_failures_deleted: "12",
          deployments_deleted: "5",
          notices_deleted: "2",
          info_notices_resolved: "0",
          doc_dirs_deleted: "0",
        },
      ],
    ]);
    const summary = await getCleanupSummary(RANGE, sql);
    expect(summary).toEqual({
      work_items_deleted: 3,
      approval_requests_deleted: 5,
      job_failures_deleted: 12,
      deployments_deleted: 5,
      notices_deleted: 2,
      info_notices_resolved: 0,
      doc_dirs_deleted: 0,
    });
  });

  test("sums the resolved info notices", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          run_count: 2,
          work_items_deleted: 0,
          approval_requests_deleted: 0,
          job_failures_deleted: 0,
          deployments_deleted: 0,
          notices_deleted: 0,
          info_notices_resolved: "4",
          doc_dirs_deleted: 0,
        },
      ],
    ]);
    const summary = await getCleanupSummary(RANGE, sql);
    expect(summary?.info_notices_resolved).toBe(4);
  });

  test("selects the info_notices_resolved column", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getCleanupSummary(RANGE, sql);
    expect(calls[0]?.text).toContain("sum(info_notices_resolved)");
  });

  test("returns null when no cleanup_runs row falls in range", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          run_count: 0,
          work_items_deleted: 0,
          approval_requests_deleted: 0,
          job_failures_deleted: 0,
          deployments_deleted: 0,
          notices_deleted: 0,
          info_notices_resolved: 0,
          doc_dirs_deleted: 0,
        },
      ],
    ]);
    const summary = await getCleanupSummary(RANGE, sql);
    expect(summary).toBeNull();
  });

  test("returns null when the query returns no row at all", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const summary = await getCleanupSummary(RANGE, sql);
    expect(summary).toBeNull();
  });
});
