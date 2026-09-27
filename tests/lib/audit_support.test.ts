import { describe, expect, test } from "bun:test";
import {
  buildAuditTitle,
  computeAuditPeriod,
  DAY_MS,
  decideAuditKickoff,
  formatAuditPeriodLabel,
  formatJstDate,
  parsePeriodArgs,
} from "../../f/factory/lib/audit_support.ts";

describe("formatJstDate", () => {
  test("formats the JST calendar date", () => {
    // 2026-09-21T15:00:00Z is 2026-09-22 00:00 JST.
    expect(formatJstDate(new Date("2026-09-21T15:00:00Z"))).toBe("2026-09-22");
  });
});

describe("formatAuditPeriodLabel", () => {
  test("shows the last included day, not the exclusive end", () => {
    const label = formatAuditPeriodLabel(
      new Date("2026-09-21T15:00:00Z"),
      new Date("2026-09-28T15:00:00Z"),
    );
    expect(label).toBe("2026-09-22〜2026-09-28");
  });
});

const NOW = new Date("2026-09-28T00:30:00Z"); // 2026-09-28 09:30 JST
const END = new Date("2026-09-27T15:00:00Z"); // 2026-09-28 00:00 JST
const COUNTS_NONE = {
  job_failures: 0,
  decided_approvals: 0,
  agent_runs: 0,
  fix_rounds: 0,
  reviews: 0,
  deployments: 0,
  notices: 0,
};

describe("computeAuditPeriod", () => {
  test("ends at today's JST midnight", () => {
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: null,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.end).toEqual(END);
  });

  test("starts `days` before the end when there is no previous report", () => {
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: null,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.start).toEqual(new Date("2026-09-20T15:00:00Z"));
  });

  test("starts at the previous report's end", () => {
    const last = new Date("2026-09-24T15:00:00Z");
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: last,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.start).toEqual(last);
  });

  test("clamps the start to max_lookback_days and reports the gap", () => {
    // NOTE: the brief's Step-1 example expected 59 here, but the floor
    // (end - 28 days = 2026-08-30T15:00:00Z) minus last
    // (2026-07-01T15:00:00Z) is an exact 60-day span regardless of
    // ceil/floor rounding — 59 does not match the brief's own Step-3
    // algorithm for these inputs. Corrected to 60; flagged to the
    // controller in the task report.
    const last = new Date("2026-07-01T15:00:00Z");
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: last,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.unaudited_gap_days).toBe(60);
  });

  test("caps `days` at max_lookback_days", () => {
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: null,
      days: 90,
      maxLookbackDays: 28,
    });
    expect(period?.start).toEqual(new Date("2026-08-30T15:00:00Z"));
  });

  test("returns null when the previous report already covers today", () => {
    expect(
      computeAuditPeriod({
        now: NOW,
        lastPeriodEnd: END,
        days: 7,
        maxLookbackDays: 28,
      }),
    ).toBeNull();
  });

  test("starts exactly at the floor with no gap when the previous report ends there", () => {
    const floor = new Date(END.getTime() - 28 * DAY_MS);
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: floor,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.start).toEqual(floor);
  });

  test("reports no gap when the previous report ends exactly at the floor", () => {
    const floor = new Date(END.getTime() - 28 * DAY_MS);
    const period = computeAuditPeriod({
      now: NOW,
      lastPeriodEnd: floor,
      days: 7,
      maxLookbackDays: 28,
    });
    expect(period?.unaudited_gap_days).toBe(0);
  });
});

describe("buildAuditTitle", () => {
  test("wraps the period label in 監査() with no half-width space", () => {
    const period = {
      start: new Date("2026-09-21T15:00:00Z"),
      end: new Date("2026-09-28T15:00:00Z"),
      unaudited_gap_days: 0,
    };
    expect(buildAuditTitle(period)).toBe("監査(2026-09-22〜2026-09-28)");
  });
});

describe("parsePeriodArgs", () => {
  test("throws on an inverted range", () => {
    expect(() =>
      parsePeriodArgs("2026-09-28T15:00:00Z", "2026-09-21T15:00:00Z", 3),
    ).toThrow();
  });

  test("parses a valid range and passes through the gap", () => {
    const period = parsePeriodArgs(
      "2026-09-21T15:00:00Z",
      "2026-09-28T15:00:00Z",
      3,
    );
    expect(period.unaudited_gap_days).toBe(3);
  });

  test("throws on an unparsable date", () => {
    expect(() =>
      parsePeriodArgs("not-a-date", "2026-09-28T15:00:00Z", 0),
    ).toThrow();
  });

  test("clamps a negative gap to 0", () => {
    const period = parsePeriodArgs(
      "2026-09-21T15:00:00Z",
      "2026-09-28T15:00:00Z",
      -2,
    );
    expect(period.unaudited_gap_days).toBe(0);
  });
});

describe("decideAuditKickoff", () => {
  const period = {
    start: new Date("2026-09-20T15:00:00Z"),
    end: END,
    unaudited_gap_days: 0,
  };

  test("skips while another audit is in progress, even with force", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 1,
        period,
        force: true,
        counts: null,
        budgetExceeded: false,
      }),
    ).toEqual({ action: "skip", reason: "audit_in_progress" });
  });

  test("skips an empty period", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 0,
        period: null,
        force: true,
        counts: null,
        budgetExceeded: false,
      }),
    ).toEqual({ action: "skip", reason: "empty_period" });
  });

  test("skips when nothing actionable happened", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 0,
        period,
        force: false,
        counts: COUNTS_NONE,
        budgetExceeded: false,
      }),
    ).toEqual({ action: "skip", reason: "no_new_records" });
  });

  test("force overrides the no-new-records skip", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 0,
        period,
        force: true,
        counts: COUNTS_NONE,
        budgetExceeded: false,
      }).action,
    ).toBe("run");
  });

  test("skips when the daily budget is exceeded, even with force", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 0,
        period,
        force: true,
        counts: null,
        budgetExceeded: true,
      }),
    ).toEqual({ action: "skip", reason: "daily_budget_exceeded" });
  });

  test("runs when there is at least one actionable record", () => {
    expect(
      decideAuditKickoff({
        activeAuditCount: 0,
        period,
        force: false,
        counts: { ...COUNTS_NONE, job_failures: 1 },
        budgetExceeded: false,
      }),
    ).toEqual({ action: "run", period });
  });
});
