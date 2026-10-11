import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentCostDailyRow,
  ApprovalStatsRow,
  LeadTimeRow,
} from "../api/guards/analytics.ts";
import {
  dailyTotals,
  fillDailyTotals,
  firstTryApprovalRate,
  formatHours,
  formatIsoDate,
  formatMonthDay,
  formatPercent,
  formatUsd,
  hitsRowLimit,
  leadTimeByStatus,
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

describe("fillDailyTotals", () => {
  const NOW = new Date("2026-10-11T15:30:00.000Z");
  const total = (day: string, runCount: number) => ({
    day,
    costUsd: runCount,
    runCount,
  });

  test("lists every day of the period, ending today", () => {
    const filled = fillDailyTotals([], 7, NOW);
    expect(filled.map((entry) => entry.day)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  test("fills a day without runs with zero", () => {
    const filled = fillDailyTotals([total("2026-10-08", 3)], 7, NOW);
    expect(filled.find((entry) => entry.day === "2026-10-09")).toEqual({
      day: "2026-10-09",
      costUsd: 0,
      runCount: 0,
    });
  });

  test("keeps the totals of a day with runs", () => {
    const filled = fillDailyTotals([total("2026-10-08", 3)], 7, NOW);
    expect(filled.find((entry) => entry.day === "2026-10-08")).toEqual(
      total("2026-10-08", 3),
    );
  });

  test("keeps the gap between distant days", () => {
    const filled = fillDailyTotals(
      [total("2026-09-28", 1), total("2026-10-08", 1)],
      30,
      NOW,
    );
    expect(filled.length).toBe(30);
  });

  test("fills the days between distant days with zero", () => {
    const filled = fillDailyTotals(
      [total("2026-09-28", 1), total("2026-10-08", 1)],
      30,
      NOW,
    );
    expect(filled.find((entry) => entry.day === "2026-10-03")?.runCount).toBe(
      0,
    );
  });

  describe("in a time zone far from UTC", () => {
    const originalTimeZone = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = "Asia/Tokyo";
    });
    afterEach(() => {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    });

    test("counts the days in UTC rather than the local time zone", () => {
      // 東京では翌日の朝になる時刻。端末の暦で数えると最後の日が1日進む。
      const lateInUtcDay = new Date("2026-10-11T23:59:59.000Z");
      expect(fillDailyTotals([], 7, lateInUtcDay).at(-1)?.day).toBe(
        "2026-10-11",
      );
    });
  });

  test("crosses a month boundary", () => {
    const filled = fillDailyTotals([], 7, new Date("2026-11-01T00:00:00.000Z"));
    expect(filled.slice(-3).map((entry) => entry.day)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  test("extends the range to a day after today", () => {
    const filled = fillDailyTotals([total("2026-10-12", 2)], 7, NOW);
    expect(filled.at(-1)?.day).toBe("2026-10-12");
  });

  test("extends the range to a day before the period", () => {
    const filled = fillDailyTotals([total("2026-10-01", 2)], 7, NOW);
    expect(filled[0]?.day).toBe("2026-10-01");
  });

  test("drops a day that is not a date", () => {
    const filled = fillDailyTotals([total("unknown", 2)], 7, NOW);
    expect(filled.some((entry) => entry.day === "unknown")).toBe(false);
  });

  test("returns the period of zero days for no rows", () => {
    const filled = fillDailyTotals([], 7, NOW);
    expect(filled.map((entry) => entry.runCount)).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test("does not fill the days before the oldest fetched day when truncated", () => {
    const filled = fillDailyTotals(
      [total("2026-10-08", 1), total("2026-10-09", 1)],
      30,
      NOW,
      true,
    );
    expect(filled[0]?.day).toBe("2026-10-08");
  });

  test("still fills up to today when truncated", () => {
    const filled = fillDailyTotals([total("2026-10-08", 1)], 30, NOW, true);
    expect(filled.at(-1)?.day).toBe("2026-10-11");
  });

  test("fills the whole period when truncated but no day was fetched", () => {
    expect(fillDailyTotals([], 7, NOW, true).length).toBe(7);
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
