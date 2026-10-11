import { describe, expect, test } from "bun:test";
import {
  isAgentCostDailyRows,
  isApprovalStatsRows,
  isLeadTimeRows,
} from "./analytics.ts";

const DAY = "2026-10-08T00:00:00.000Z";

const COST_ROW = {
  day: DAY,
  stage: "requirements",
  model: "sonnet",
  run_count: 3,
  total_cost_usd: 1.25,
  total_input_tokens: 1000,
  total_output_tokens: 200,
  total_cache_read_tokens: null,
  total_turns: 12,
  avg_duration_ms: 3400.5,
};

const APPROVAL_ROW = {
  day: DAY,
  decision: "approved",
  attempt: 1,
  decision_count: 2,
};

const LEAD_ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: null,
  status: "pr_open",
  created_at: DAY,
  updated_at: DAY,
  lead_time_seconds: 7200.5,
};

describe("isAgentCostDailyRows", () => {
  test("accepts an empty list", () => {
    expect(isAgentCostDailyRows([])).toBe(true);
  });

  test("accepts a row with null totals", () => {
    expect(
      isAgentCostDailyRows([
        { ...COST_ROW, total_cost_usd: null, avg_duration_ms: null },
      ]),
    ).toBe(true);
  });

  test("rejects a day without a UTC offset", () => {
    expect(isAgentCostDailyRows([{ ...COST_ROW, day: "2026-10-08" }])).toBe(
      false,
    );
  });

  test("rejects a cost that is a string", () => {
    expect(
      isAgentCostDailyRows([{ ...COST_ROW, total_cost_usd: "1.25" }]),
    ).toBe(false);
  });

  test("rejects a row that lacks the run count", () => {
    const { run_count: _omitted, ...rest } = COST_ROW;
    expect(isAgentCostDailyRows([rest])).toBe(false);
  });

  test("rejects a value that is not a list", () => {
    expect(isAgentCostDailyRows(COST_ROW)).toBe(false);
  });
});

describe("isApprovalStatsRows", () => {
  test("accepts a complete row", () => {
    expect(isApprovalStatsRows([APPROVAL_ROW])).toBe(true);
  });

  test("rejects an attempt of zero", () => {
    expect(isApprovalStatsRows([{ ...APPROVAL_ROW, attempt: 0 }])).toBe(false);
  });

  test("rejects a negative decision count", () => {
    expect(isApprovalStatsRows([{ ...APPROVAL_ROW, decision_count: -1 }])).toBe(
      false,
    );
  });
});

describe("isLeadTimeRows", () => {
  test("accepts a row without an issue number", () => {
    expect(isLeadTimeRows([LEAD_ROW])).toBe(true);
  });

  test("accepts a row with an issue number", () => {
    expect(isLeadTimeRows([{ ...LEAD_ROW, issue_number: 42 }])).toBe(true);
  });

  test("rejects a lead time that is not finite", () => {
    expect(
      isLeadTimeRows([{ ...LEAD_ROW, lead_time_seconds: Number.NaN }]),
    ).toBe(false);
  });

  test("rejects a row whose status is missing", () => {
    const { status: _omitted, ...rest } = LEAD_ROW;
    expect(isLeadTimeRows([rest])).toBe(false);
  });
});
