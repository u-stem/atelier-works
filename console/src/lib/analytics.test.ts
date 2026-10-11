import { describe, expect, test } from "bun:test";
import type {
  AgentCostDailyRow,
  ApprovalStatsRow,
  LeadTimeRow,
} from "../api/guards/analytics.ts";
import {
  dailyTotals,
  firstTryApprovalRate,
  formatHours,
  formatIsoDate,
  formatMonthDay,
  formatPercent,
  formatUsd,
  hitsRowLimit,
  leadTimeByStatus,
  periodButtonStyle,
  rejectionsByAttempt,
} from "./analytics.ts";

function costRow(overrides: Partial<AgentCostDailyRow>): AgentCostDailyRow {
  return {
    day: "2026-10-08T00:00:00.000Z",
    stage: "requirements",
    model: "sonnet",
    run_count: 1,
    total_cost_usd: 1,
    total_input_tokens: null,
    total_output_tokens: null,
    total_cache_read_tokens: null,
    total_turns: null,
    avg_duration_ms: null,
    ...overrides,
  };
}

function approvalRow(overrides: Partial<ApprovalStatsRow>): ApprovalStatsRow {
  return {
    day: "2026-10-08T00:00:00.000Z",
    decision: "approved",
    attempt: 1,
    decision_count: 1,
    ...overrides,
  };
}

function leadRow(overrides: Partial<LeadTimeRow>): LeadTimeRow {
  return {
    work_item_id: 1,
    owner: "o",
    repo: "r",
    issue_number: null,
    status: "pr_open",
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T01:00:00.000Z",
    lead_time_seconds: 3600,
    ...overrides,
  };
}

describe("dailyTotals", () => {
  test("sums the cost of rows on the same day", () => {
    const totals = dailyTotals([
      costRow({ stage: "a", total_cost_usd: 1.5 }),
      costRow({ stage: "b", total_cost_usd: 2 }),
    ]);
    expect(totals[0]?.costUsd).toBe(3.5);
  });

  test("sums the run count of rows on the same day", () => {
    const totals = dailyTotals([
      costRow({ run_count: 2 }),
      costRow({ stage: "b", run_count: 3 }),
    ]);
    expect(totals[0]?.runCount).toBe(5);
  });

  test("counts a null cost as zero", () => {
    expect(dailyTotals([costRow({ total_cost_usd: null })])[0]?.costUsd).toBe(
      0,
    );
  });

  test("orders the days from oldest to newest", () => {
    const totals = dailyTotals([
      costRow({ day: "2026-10-09T00:00:00.000Z" }),
      costRow({ day: "2026-10-07T00:00:00.000Z" }),
    ]);
    expect(totals.map((total) => total.day)).toEqual([
      "2026-10-07",
      "2026-10-09",
    ]);
  });

  test("returns an empty list for no rows", () => {
    expect(dailyTotals([])).toEqual([]);
  });
});

describe("firstTryApprovalRate", () => {
  test("is the share of approvals among first attempt decisions", () => {
    const rate = firstTryApprovalRate([
      approvalRow({ decision: "approved", decision_count: 3 }),
      approvalRow({ decision: "rejected", decision_count: 1 }),
    ]);
    expect(rate).toBe(75);
  });

  test("ignores decisions after the first attempt", () => {
    const rate = firstTryApprovalRate([
      approvalRow({ decision: "approved", decision_count: 1 }),
      approvalRow({ decision: "rejected", attempt: 2, decision_count: 9 }),
    ]);
    expect(rate).toBe(100);
  });

  test("ignores decisions other than approved and rejected", () => {
    const rate = firstTryApprovalRate([
      approvalRow({ decision: "expired", decision_count: 5 }),
    ]);
    expect(rate).toBeNull();
  });

  test("is null for no rows", () => {
    expect(firstTryApprovalRate([])).toBeNull();
  });
});

describe("rejectionsByAttempt", () => {
  test("sums rejections of the same attempt across days", () => {
    const result = rejectionsByAttempt([
      approvalRow({ decision: "rejected", decision_count: 2 }),
      approvalRow({
        day: "2026-10-09T00:00:00.000Z",
        decision: "rejected",
        decision_count: 1,
      }),
    ]);
    expect(result).toEqual([{ attempt: 1, count: 3 }]);
  });

  test("leaves out approvals", () => {
    expect(
      rejectionsByAttempt([approvalRow({ decision: "approved" })]),
    ).toEqual([]);
  });

  test("orders by attempt", () => {
    const result = rejectionsByAttempt([
      approvalRow({ decision: "rejected", attempt: 3 }),
      approvalRow({ decision: "rejected", attempt: 2 }),
    ]);
    expect(result.map((entry) => entry.attempt)).toEqual([2, 3]);
  });
});

describe("leadTimeByStatus", () => {
  test("averages the lead time of a status in hours", () => {
    const result = leadTimeByStatus([
      leadRow({ lead_time_seconds: 3600 }),
      leadRow({ work_item_id: 2, lead_time_seconds: 10800 }),
    ]);
    expect(result[0]?.averageHours).toBe(2);
  });

  test("counts the work items of a status", () => {
    const result = leadTimeByStatus([
      leadRow({}),
      leadRow({ work_item_id: 2 }),
    ]);
    expect(result[0]?.count).toBe(2);
  });

  test("puts the longest average first", () => {
    const result = leadTimeByStatus([
      leadRow({ status: "failed", lead_time_seconds: 3600 }),
      leadRow({ status: "pr_open", lead_time_seconds: 7200 }),
    ]);
    expect(result.map((entry) => entry.status)).toEqual(["pr_open", "failed"]);
  });

  test("returns an empty list for no rows", () => {
    expect(leadTimeByStatus([])).toEqual([]);
  });
});

describe("formatMonthDay", () => {
  test("shows the month and day in UTC", () => {
    expect(formatMonthDay("2026-10-08T00:00:00.000Z")).toBe("10/8");
  });

  test("returns a value that is not a date as it is", () => {
    expect(formatMonthDay("not a date")).toBe("not a date");
  });
});

describe("formatIsoDate", () => {
  test("shows the year, month and day in UTC", () => {
    expect(formatIsoDate("2026-10-08T23:59:59.000Z")).toBe("2026-10-08");
  });
});

describe("formatUsd", () => {
  test("rounds to cents", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});

describe("formatHours", () => {
  test("rounds to one decimal place", () => {
    expect(formatHours(2.26)).toBe("2.3h");
  });

  test("drops a trailing zero", () => {
    expect(formatHours(3)).toBe("3h");
  });
});

describe("formatPercent", () => {
  test("shows one decimal place", () => {
    expect(formatPercent(66.666)).toBe("66.7%");
  });
});

describe("hitsRowLimit", () => {
  test("is true when the row count reaches the limit", () => {
    expect(hitsRowLimit(2000, 2000)).toBe(true);
  });

  test("is false below the limit", () => {
    expect(hitsRowLimit(1999, 2000)).toBe(false);
  });
});

describe("periodButtonStyle", () => {
  test("outlines the selected period with the primary color", () => {
    expect(periodButtonStyle(true).className).toContain("border-primary");
  });

  test("keeps the font weight so that the neighbors do not move", () => {
    expect(periodButtonStyle(true).className).not.toContain("font-");
  });

  test("leaves the other periods plain", () => {
    expect(periodButtonStyle(false).className).toBe("");
  });

  test("fills only the selected period", () => {
    expect([
      periodButtonStyle(true).variant,
      periodButtonStyle(false).variant,
    ]).toEqual(["secondary", "outline"]);
  });
});
