import { describe, expect, test } from "bun:test";
import type { NotifyBestEffortResult } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  computeYesterdayRangeJst,
  type DayRange,
  planSummaryDays,
} from "../../f/factory/lib/summary_support.ts";
import type { WorkerLoadSummary } from "../../f/factory/lib/worker_load_support.ts";
import {
  assertAllDelivered,
  CATCHUP_INTERVAL_MS,
  type DailySummaryResult,
  readWorkerLoad,
  runDailySummary,
  type SummarizedDay,
  summarizePendingDays,
} from "../../f/factory/notify_daily_summary.ts";

const RANGE = computeYesterdayRangeJst(new Date("2026-10-13T00:05:00Z"));

const SUMMARY: WorkerLoadSummary = {
  sample_count: 718,
  expected_count: 720,
  lag_max_seconds: 4,
  lag_over_count: 0,
  lag_over_total_seconds: 0,
  gap_count: 0,
  gap_longest_seconds: null,
  gap_longest_from: null,
  gap_longest_to: null,
  running_jobs_max: 1,
  slots_max: 3,
  mem_anon_max_bytes: 80_000_000,
  mem_anon_max_ratio: 0.02,
  mem_working_set_max_bytes: 270_000_000,
  mem_oom_increase: 0,
  mem_oom_kill_increase: 0,
  max_wait_max_seconds: 0,
};

function captureLog() {
  const lines: string[] = [];
  const log = logger("test", {
    sink: (line) => {
      lines.push(line);
    },
  });
  return { log, lines };
}

describe("readWorkerLoad", () => {
  test("returns the summary the query produced", async () => {
    const { log } = captureLog();
    const result = await readWorkerLoad(
      RANGE,
      () => Promise.resolve(SUMMARY),
      log,
    );
    expect(result).toEqual({ kind: "summary", summary: SUMMARY });
  });

  test("returns no_record when the query has no sample", async () => {
    const { log } = captureLog();
    const result = await readWorkerLoad(
      RANGE,
      () => Promise.resolve(null),
      log,
    );
    expect(result).toEqual({ kind: "no_record" });
  });

  test("returns read_failed instead of throwing when the query fails", async () => {
    const { log } = captureLog();
    const result = await readWorkerLoad(
      RANGE,
      () => Promise.reject(new Error("relation does not exist")),
      log,
    );
    expect(result).toEqual({ kind: "read_failed" });
  });

  test("warns with the cause when the query fails", async () => {
    const { log, lines } = captureLog();
    await readWorkerLoad(
      RANGE,
      () => Promise.reject(new Error("connection refused")),
      log,
    );
    expect(lines.join("\n")).toContain("connection refused");
  });

  test("does not warn when there is simply no record", async () => {
    const { log, lines } = captureLog();
    await readWorkerLoad(RANGE, () => Promise.resolve(null), log);
    expect(lines).toHaveLength(0);
  });
});

describe("summarizePendingDays", () => {
  // 2026-10-14T00:05:00ZはJSTで2026-10-14 09:05。昨日は2026-10-13。
  const NOW = new Date("2026-10-14T00:05:00Z");
  const SENT: NotifyBestEffortResult = { status: "sent" };

  function resultFor(range: DayRange): DailySummaryResult {
    return {
      day: range.label,
      run_count: 0,
      total_cost_usd: 0,
      failure_count: 0,
      approved_count: 0,
      rejected_count: 0,
      cleanup: null,
      worker_load: { kind: "no_record" },
    };
  }

  function setup(options: {
    lastDay: string | null;
    delivery?: (range: DayRange) => NotifyBestEffortResult;
    failOn?: string;
  }) {
    const { log, lines } = captureLog();
    const summarized: string[] = [];
    const saved: string[] = [];
    const sleeps: number[] = [];
    const run = () =>
      summarizePendingDays(planSummaryDays(options.lastDay, NOW), {
        summarizeDay: (range): Promise<SummarizedDay> => {
          summarized.push(range.label);
          if (range.label === options.failOn) {
            return Promise.reject(new Error("aggregate failed"));
          }
          return Promise.resolve({
            result: resultFor(range),
            delivery: options.delivery?.(range) ?? SENT,
          });
        },
        saveLastDay: (label) => {
          saved.push(label);
          return Promise.resolve();
        },
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        log,
      });
    return { run, summarized, saved, sleeps, lines };
  }

  test("summarizes the missed days from oldest to newest", async () => {
    const { run, summarized } = setup({ lastDay: "2026-10-10" });
    await run();
    expect(summarized).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  test("saves the day after each successful summary", async () => {
    const { run, saved } = setup({ lastDay: "2026-10-10" });
    await run();
    expect(saved).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  test("returns the summarized days", async () => {
    const { run } = setup({ lastDay: "2026-10-11" });
    const result = await run();
    expect(result.days.map((day) => day.day)).toEqual([
      "2026-10-12",
      "2026-10-13",
    ]);
  });

  test("does nothing when there is no day to summarize", async () => {
    const { run, summarized } = setup({ lastDay: "2026-10-13" });
    await run();
    expect(summarized).toEqual([]);
  });

  test("rejects when a day fails to aggregate", async () => {
    const { run } = setup({ lastDay: "2026-10-10", failOn: "2026-10-12" });
    await expect(run()).rejects.toThrow("aggregate failed");
  });

  test("does not save the day that failed to aggregate", async () => {
    const { run, saved } = setup({
      lastDay: "2026-10-10",
      failOn: "2026-10-12",
    });
    await run().catch(() => undefined);
    expect(saved).toEqual(["2026-10-11"]);
  });

  test("does not summarize later days after a failure", async () => {
    const { run, summarized } = setup({
      lastDay: "2026-10-10",
      failOn: "2026-10-12",
    });
    await run().catch(() => undefined);
    expect(summarized).toEqual(["2026-10-11", "2026-10-12"]);
  });

  test("does not save a day whose notification was not sent", async () => {
    const { run, saved } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await run();
    expect(saved).toEqual(["2026-10-11"]);
  });

  test("stops at the day whose notification was not sent", async () => {
    const { run, summarized } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await run();
    expect(summarized).toEqual(["2026-10-11", "2026-10-12"]);
  });

  test("reports the day whose notification was not sent", async () => {
    const { run } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    const result = await run();
    expect(result.undelivered_day).toBe("2026-10-12");
  });

  test("reports no undelivered day when every notification was sent", async () => {
    const { run } = setup({ lastDay: "2026-10-10" });
    const result = await run();
    expect(result.undelivered_day).toBeNull();
  });

  test("rejects after the loop when a notification was not sent", async () => {
    const { run } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await expect(run().then(assertAllDelivered)).rejects.toThrow("2026-10-12");
  });

  test("keeps the state of the days delivered before the failure", async () => {
    const { run, saved } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await run()
      .then(assertAllDelivered)
      .catch(() => undefined);
    expect(saved).toEqual(["2026-10-11"]);
  });

  test("includes the reason in the rejection", async () => {
    const { run } = setup({
      lastDay: "2026-10-12",
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await expect(run().then(assertAllDelivered)).rejects.toThrow("http 500");
  });

  test("returns the result when every notification was sent", async () => {
    const { run } = setup({ lastDay: "2026-10-12" });
    const result = await run().then(assertAllDelivered);
    expect(result.days.map((day) => day.day)).toEqual(["2026-10-13"]);
  });

  test("saves the day when no webhook is configured", async () => {
    const { run, saved } = setup({
      lastDay: "2026-10-12",
      delivery: () => ({ status: "no_webhook" }),
    });
    await run();
    expect(saved).toEqual(["2026-10-13"]);
  });

  test("goes through every day when no webhook is configured", async () => {
    const { run, summarized } = setup({
      lastDay: "2026-10-10",
      delivery: () => ({ status: "no_webhook" }),
    });
    await run();
    expect(summarized).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  test("advances the state for every day when no webhook is configured", async () => {
    const { run, saved } = setup({
      lastDay: "2026-10-10",
      delivery: () => ({ status: "no_webhook" }),
    });
    await run();
    expect(saved).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  test("warns when the saved day is later than yesterday", async () => {
    const { run, lines } = setup({ lastDay: "2026-10-20" });
    await run();
    expect(lines.join("\n")).toContain("later than yesterday");
  });

  test("summarizes yesterday when the saved day is later than yesterday", async () => {
    const { run, summarized } = setup({ lastDay: "2026-10-20" });
    await run();
    expect(summarized).toEqual(["2026-10-13"]);
  });

  test("overwrites the saved day when it is later than yesterday", async () => {
    const { run, saved } = setup({ lastDay: "2026-10-20" });
    await run();
    expect(saved).toEqual(["2026-10-13"]);
  });

  test("waits between days of a catch-up", async () => {
    const { run, sleeps } = setup({ lastDay: "2026-10-10" });
    await run();
    expect(sleeps).toEqual([CATCHUP_INTERVAL_MS, CATCHUP_INTERVAL_MS]);
  });

  test("does not wait when only one day is sent", async () => {
    const { run, sleeps } = setup({ lastDay: "2026-10-12" });
    await run();
    expect(sleeps).toEqual([]);
  });

  test("does not wait after the day whose notification was not sent", async () => {
    const { run, sleeps } = setup({
      lastDay: "2026-10-10",
      delivery: (range) =>
        range.label === "2026-10-11"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await run();
    expect(sleeps).toEqual([]);
  });

  test("does not wait when no webhook is configured", async () => {
    const { run, sleeps } = setup({
      lastDay: "2026-10-10",
      delivery: () => ({ status: "no_webhook" }),
    });
    await run();
    expect(sleeps).toEqual([]);
  });

  test("warns about the days skipped beyond the limit", async () => {
    const { run, lines } = setup({ lastDay: "2026-10-01" });
    await run();
    expect(lines.join("\n")).toContain("skipped");
  });

  test("does not warn when no day is skipped", async () => {
    const { run, lines } = setup({ lastDay: "2026-10-10" });
    await run();
    expect(lines).toHaveLength(0);
  });
});

describe("runDailySummary", () => {
  const SENT: NotifyBestEffortResult = { status: "sent" };

  function resultFor(range: DayRange): DailySummaryResult {
    return {
      day: range.label,
      run_count: 0,
      total_cost_usd: 0,
      failure_count: 0,
      approved_count: 0,
      rejected_count: 0,
      cleanup: null,
      worker_load: { kind: "no_record" },
    };
  }

  /** stateを1つの変数に保存する。実行をまたいで同じストアを使える。 */
  function setup(options: {
    state: unknown;
    delivery?: (range: DayRange) => NotifyBestEffortResult;
  }) {
    const { log, lines } = captureLog();
    const store = { value: options.state };
    const summarized: string[] = [];
    const run = (now: string) =>
      runDailySummary({
        getState: () => Promise.resolve(store.value),
        setState: (state) => {
          store.value = state;
          return Promise.resolve();
        },
        summarizeDay: (range) => {
          summarized.push(range.label);
          return Promise.resolve({
            result: resultFor(range),
            delivery: options.delivery?.(range) ?? SENT,
          });
        },
        sleep: () => Promise.resolve(),
        now: () => new Date(now),
        log,
      });
    return { run, store, summarized, lines };
  }

  const NOW = "2026-10-14T00:05:00Z";
  const NEXT_DAY = "2026-10-15T00:05:00Z";

  test("rejects when a notification was not sent", async () => {
    const { run } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await expect(run(NOW)).rejects.toThrow("not delivered");
  });

  test("keeps the state of the day whose notification was not sent", async () => {
    const { run, store } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await run(NOW).catch(() => undefined);
    expect(store.value).toEqual({ last_day: "2026-10-12" });
  });

  test("starts the next run from the day after the saved one", async () => {
    const { run, summarized } = setup({ state: null });
    await run(NOW);
    await run(NEXT_DAY);
    expect(summarized).toEqual(["2026-10-13", "2026-10-14"]);
  });

  test("does not summarize the same day twice in the same day", async () => {
    const { run, summarized } = setup({ state: null });
    await run(NOW);
    await run(NOW);
    expect(summarized).toEqual(["2026-10-13"]);
  });

  test("saves the last summarized day", async () => {
    const { run, store } = setup({ state: { last_day: "2026-10-10" } });
    await run(NOW);
    expect(store.value).toEqual({ last_day: "2026-10-13" });
  });

  test("warns when the saved state could not be read", async () => {
    const { run, lines } = setup({ state: { last_day: "2026-02-30" } });
    await run(NOW);
    expect(lines.join("\n")).toContain("could not be read");
  });

  test("summarizes yesterday when the saved state could not be read", async () => {
    const { run, summarized } = setup({ state: { last_day: "2026-02-30" } });
    await run(NOW);
    expect(summarized).toEqual(["2026-10-13"]);
  });

  test("does not warn about the initial empty state", async () => {
    const { run, lines } = setup({ state: null });
    await run(NOW);
    expect(lines).toHaveLength(0);
  });

  test("repairs a saved day later than yesterday", async () => {
    const { run, store } = setup({ state: { last_day: "2026-10-20" } });
    await run(NOW);
    expect(store.value).toEqual({ last_day: "2026-10-13" });
  });
});
