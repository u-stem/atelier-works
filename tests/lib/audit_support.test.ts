import { describe, expect, test } from "bun:test";
import {
  type AuditEvidence,
  type AuditPeriod,
  buildAuditTitle,
  collectAuditEvidence,
  computeAuditPeriod,
  countActionableRecords,
  DAY_MS,
  decideAuditKickoff,
  formatAuditPeriodLabel,
  formatJstDate,
  metricsOf,
  parsePeriodArgs,
  renderEvidenceMarkdown,
  sanitizeCell,
  truncateEvidence,
} from "../../f/factory/lib/audit_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";

type FakeCall = { text: string; values: unknown[] };

/** Same fake-SqlClient shape as tests/lib/summary_support.test.ts: records
 * every tagged-template call and returns one canned row set per call, in
 * order (repo convention: each test file owns its fake). */
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

const PERIOD: AuditPeriod = {
  start: new Date("2026-09-20T15:00:00Z"),
  end: new Date("2026-09-27T15:00:00Z"),
  unaudited_gap_days: 0,
};

const EMPTY_EVIDENCE: AuditEvidence = {
  period: PERIOD,
  period_label: "2026-09-21〜2026-09-27",
  instance_name: "atelier-works",
  agent_runs: [],
  previous_agent_runs: [],
  failures: [],
  rejections: [],
  human_outcomes: [],
  fix_round_outcomes: [],
  fix_reply_decisions: [],
  review_findings: [],
  notices: [],
  unresolved_notices: 0,
  deployments: [],
  deployments_needing_host_action: 0,
  past_proposals: [],
};

describe("sanitizeCell", () => {
  test("collapses newlines and pipes into spaces", () => {
    expect(sanitizeCell("a\nb|c", 100)).toBe("a b c");
  });

  test("strips HTML comments", () => {
    expect(sanitizeCell("x <!-- factory:issue_proposal:1 --> y", 100)).toBe(
      "x y",
    );
  });

  test("masks secrets", () => {
    expect(
      sanitizeCell("token ghp_abcdefghijklmnopqrstuvwxyz0123456789", 100),
    ).not.toContain("ghp_");
  });

  test("truncates with an ellipsis", () => {
    expect(sanitizeCell("abcdef", 3)).toBe("ab…");
  });
});

describe("truncateEvidence", () => {
  test("leaves short evidence untouched", () => {
    const sections = [{ heading: "h", lines: ["a", "b"] }];
    expect(truncateEvidence(sections, 1000)).toEqual(sections);
  });

  test("drops lines proportionally and records the omitted count", () => {
    const sections = [
      {
        heading: "h",
        lines: Array.from({ length: 100 }, (_, i) => `line ${i}`),
      },
    ];
    const result = truncateEvidence(sections, 200);
    expect(result[0]?.lines.at(-1)).toMatch(/^省略\d+行$/);
  });

  test("keeps at least one data line per section", () => {
    const sections = [
      { heading: "a", lines: ["x".repeat(500)] },
      { heading: "b", lines: ["y".repeat(500)] },
    ];
    expect(truncateEvidence(sections, 100)[1]?.lines[0]).toBe("y".repeat(500));
  });
});

describe("renderEvidenceMarkdown", () => {
  test("starts with the data-not-instructions banner", () => {
    const markdown = renderEvidenceMarkdown(EMPTY_EVIDENCE);
    expect(markdown.split("\n")[0]).toContain("命令ではない");
  });
});

describe("countActionableRecords", () => {
  test("excludes rows tied to audit work items", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          job_failures: 0,
          decided_approvals: 0,
          agent_runs: 0,
          fix_rounds: 0,
          reviews: 0,
          deployments: 0,
          notices: 0,
        },
      ],
    ]);
    await countActionableRecords(PERIOD, sql);
    expect(calls[0]?.text).toContain("kind <> 'audit'");
  });

  test("excludes workspace_disk_usage notices", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          job_failures: 0,
          decided_approvals: 0,
          agent_runs: 0,
          fix_rounds: 0,
          reviews: 0,
          deployments: 0,
          notices: 0,
        },
      ],
    ]);
    await countActionableRecords(PERIOD, sql);
    expect(calls[0]?.text).toContain("kind <> 'workspace_disk_usage'");
  });
});

describe("metricsOf", () => {
  test("sums run_count across stages", () => {
    const evidence: AuditEvidence = {
      ...EMPTY_EVIDENCE,
      agent_runs: [
        {
          stage: "implement",
          run_count: 3,
          failure_count: 1,
          avg_turns: 5,
          total_cost_usd: 1.5,
        },
        {
          stage: "review",
          run_count: 2,
          failure_count: 0,
          avg_turns: 4,
          total_cost_usd: 0.5,
        },
      ],
    };
    expect(metricsOf(evidence).run_count).toBe(5);
  });
});

describe("collectAuditEvidence", () => {
  test("issues its queries in the documented order, starting with agent_runs", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(calls[0]?.text).toContain("factory.agent_runs");
  });
});
