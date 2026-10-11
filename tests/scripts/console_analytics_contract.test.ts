// backendの"agent_cost_daily"、"approval_stats"、"lead_time"ビューの変換結果が、
// Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { ANALYTICS_ROW_LIMIT } from "../../console/src/api/analyticsQueries.ts";
import {
  isAgentCostDailyRows,
  isApprovalStatsRows,
  isLeadTimeRows,
} from "../../console/src/api/guards/analytics.ts";
import { dailyTotals } from "../../console/src/lib/analytics.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const DAY = new Date("2026-10-08T00:00:00.000Z");

// PostgreSQLのnumericとbigintは、文字列で返ることがある。
const COST_ROW: SqlRow = {
  day: DAY,
  stage: "requirements",
  model: "sonnet",
  run_count: "3",
  total_cost_usd: "1.2500",
  total_input_tokens: "1000",
  total_output_tokens: "200",
  total_cache_read_tokens: null,
  total_turns: "12",
  avg_duration_ms: "3400.5",
};

const APPROVAL_ROW: SqlRow = {
  day: DAY,
  decision: "approved",
  attempt: 1,
  decision_count: "2",
};

const LEAD_TIME_ROW: SqlRow = {
  work_item_id: "7",
  owner: "o",
  repo: "r",
  issue_number: null,
  status: "pr_open",
  created_at: DAY,
  updated_at: new Date("2026-10-08T02:00:00.000Z"),
  lead_time_seconds: "7200.5",
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function delivered(
  view: "agent_cost_daily" | "approval_stats" | "lead_time",
  rows: SqlRow[],
): Promise<unknown> {
  const result = await runConsoleQuery(
    view,
    ANALYTICS_ROW_LIMIT,
    30,
    sqlReturning(rows),
  );
  return JSON.parse(JSON.stringify(result));
}

describe("analytics contract between console_query and the console guards", () => {
  test("accepts agent_cost_daily rows", async () => {
    expect(
      isAgentCostDailyRows(await delivered("agent_cost_daily", [COST_ROW])),
    ).toBe(true);
  });

  test("accepts approval_stats rows", async () => {
    expect(
      isApprovalStatsRows(await delivered("approval_stats", [APPROVAL_ROW])),
    ).toBe(true);
  });

  test("accepts lead_time rows", async () => {
    expect(isLeadTimeRows(await delivered("lead_time", [LEAD_TIME_ROW]))).toBe(
      true,
    );
  });

  test("accepts an empty result of agent_cost_daily", async () => {
    expect(isAgentCostDailyRows(await delivered("agent_cost_daily", []))).toBe(
      true,
    );
  });

  test("accepts an empty result of approval_stats", async () => {
    expect(isApprovalStatsRows(await delivered("approval_stats", []))).toBe(
      true,
    );
  });

  test("accepts an empty result of lead_time", async () => {
    expect(isLeadTimeRows(await delivered("lead_time", []))).toBe(true);
  });

  test("keeps the day as an instant that the console reads as the UTC day", async () => {
    const rows = await delivered("agent_cost_daily", [COST_ROW]);
    expect(isAgentCostDailyRows(rows) ? dailyTotals(rows)[0]?.day : null).toBe(
      "2026-10-08",
    );
  });
});
