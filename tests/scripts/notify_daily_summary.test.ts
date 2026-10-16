import { describe, expect, test } from "bun:test";
import type { NotifyBestEffortResult } from "../../f/factory/lib/discord.ts";
import type { GatedReviewStats } from "../../f/factory/lib/gated_review_support.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  type DayRange,
  planSummaryDays,
} from "../../f/factory/lib/summary_support.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import type { WorkerLoadSummary } from "../../f/factory/lib/worker_load_support.ts";
import {
  assertAllDelivered,
  CATCHUP_INTERVAL_MS,
  type DailySummaryResult,
  readGatedReview,
  readWorkerLoad,
  runDailySummary,
  type SummarizedDay,
  summarizePendingDays,
  syncGatedNotice,
} from "../../f/factory/notify_daily_summary.ts";

const [RANGE_OR_UNDEFINED] = planSummaryDays(
  null,
  new Date("2026-10-14T00:05:00Z"),
).days;
if (RANGE_OR_UNDEFINED === undefined) {
  throw new Error("no day planned");
}
const RANGE: DayRange = RANGE_OR_UNDEFINED;

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

describe("readGatedReview", () => {
  const AS_OF = new Date("2026-10-16T00:00:00Z");
  const STATS: GatedReviewStats = {
    since: new Date("2026-10-12T00:00:00Z"),
    unposted_count: 2,
  };

  test("does not query when the mode posts reviews", async () => {
    const { log } = captureLog();
    let queried = false;
    await readGatedReview(
      "comment_only",
      AS_OF,
      () => {
        queried = true;
        return Promise.resolve(STATS);
      },
      log,
    );
    expect(queried).toBe(false);
  });

  test("returns the elapsed days when the mode is gated", async () => {
    const { log } = captureLog();
    const report = await readGatedReview(
      "gated",
      AS_OF,
      () => Promise.resolve(STATS),
      log,
    );
    expect(report).toMatchObject({ kind: "on", elapsed_days: 4 });
  });

  test("returns read_failed instead of throwing when the query fails", async () => {
    const { log } = captureLog();
    const report = await readGatedReview(
      "gated",
      AS_OF,
      () => Promise.reject(new Error("connection refused")),
      log,
    );
    expect(report).toEqual({ kind: "read_failed" });
  });

  test("warns with the cause when the query fails", async () => {
    const { log, lines } = captureLog();
    await readGatedReview(
      "gated",
      AS_OF,
      () => Promise.reject(new Error("connection refused")),
      log,
    );
    expect(lines.join("\n")).toContain("connection refused");
  });
});

describe("syncGatedNotice", () => {
  const NOTICE: NoticeRecord = { kind: "review_gated_prolonged", message: "m" };

  function deps() {
    const added: NoticeRecord[] = [];
    const resolved: NoticeRecord[] = [];
    const { log, lines } = captureLog();
    return {
      added,
      resolved,
      lines,
      value: {
        notice: NOTICE,
        addNotice: (record: NoticeRecord) => {
          added.push(record);
          return Promise.resolve(1);
        },
        resolveNotice: (record: NoticeRecord) => {
          resolved.push(record);
          return Promise.resolve(1);
        },
        log,
      },
    };
  }

  test("adds the notice when the gated state has lasted past the threshold", async () => {
    const d = deps();
    await syncGatedNotice(
      { kind: "on", since: new Date(), unposted_count: 5, elapsed_days: 3 },
      d.value,
    );
    expect(d.added).toEqual([NOTICE]);
  });

  test("adds nothing before the threshold", async () => {
    const d = deps();
    await syncGatedNotice(
      { kind: "on", since: new Date(), unposted_count: 1, elapsed_days: 2 },
      d.value,
    );
    expect(d.added).toEqual([]);
  });

  test("resolves the open notice once reviews are posted again", async () => {
    const d = deps();
    await syncGatedNotice({ kind: "off" }, d.value);
    expect(d.resolved).toEqual([NOTICE]);
  });

  test("keeps the open notice when the stats could not be read", async () => {
    const d = deps();
    await syncGatedNotice({ kind: "read_failed" }, d.value);
    expect(d.resolved).toEqual([]);
  });

  test("warns instead of throwing when the notice cannot be written", async () => {
    const d = deps();
    await syncGatedNotice(
      { kind: "on", since: new Date(), unposted_count: 5, elapsed_days: 9 },
      {
        ...d.value,
        addNotice: () => Promise.reject(new Error("db down")),
      },
    );
    expect(d.lines.join("\n")).toContain("db down");
  });
});

describe("summarizePendingDays", () => {
  // 2026-10-14T00:05:00ZはJSTで2026-10-14 09:05。昨日は2026-10-13。
  const NOW = new Date("2026-10-14T00:05:00Z");
  const SENT: NotifyBestEffortResult = { status: "sent" };
  const YESTERDAY = "2026-10-13";

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
      gated_review: { kind: "off" },
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
    await expect(
      run().then((result) => assertAllDelivered(result, YESTERDAY)),
    ).rejects.toThrow("2026-10-12");
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
      .then((result) => assertAllDelivered(result, YESTERDAY))
      .catch(() => undefined);
    expect(saved).toEqual(["2026-10-11"]);
  });

  test("includes the reason in the rejection", async () => {
    const { run } = setup({
      lastDay: "2026-10-11",
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await expect(
      run().then((result) => assertAllDelivered(result, YESTERDAY)),
    ).rejects.toThrow("http 500");
  });

  test("returns the result when every notification was sent", async () => {
    const { run } = setup({ lastDay: "2026-10-12" });
    const result = await run().then((result) =>
      assertAllDelivered(result, YESTERDAY),
    );
    expect(result.days.map((day) => day.day)).toEqual(["2026-10-13"]);
  });

  test("does not reject when only yesterday was not sent", async () => {
    const { run } = setup({
      lastDay: "2026-10-12",
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    const result = await run().then((r) => assertAllDelivered(r, YESTERDAY));
    expect(result.undelivered_day).toBe(YESTERDAY);
  });

  test("rejects when a day older than yesterday was not sent", async () => {
    const { run } = setup({
      lastDay: "2026-10-11",
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : SENT,
    });
    await expect(
      run().then((r) => assertAllDelivered(r, YESTERDAY)),
    ).rejects.toThrow("2026-10-12");
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

  test("reports the oldest skipped day in the warning", async () => {
    const { run, lines } = setup({ lastDay: "2026-10-01" });
    await run();
    expect(lines.join("\n")).toContain('"skipped_from":"2026-10-02"');
  });

  test("reports the newest skipped day in the warning", async () => {
    const { run, lines } = setup({ lastDay: "2026-10-01" });
    await run();
    expect(lines.join("\n")).toContain('"skipped_to":"2026-10-06"');
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
      gated_review: { kind: "off" },
    };
  }

  /** stateを1つの変数に保存する。実行をまたいで同じストアを使える。 */
  function setup(options: {
    state: unknown;
    delivery?: (range: DayRange) => NotifyBestEffortResult;
    /** この日の集計を、最初の1回だけ例外にする。 */
    failOnce?: string;
  }) {
    const { log, lines } = captureLog();
    const store = { value: options.state };
    const summarized: string[] = [];
    const writes: unknown[] = [];
    const failed = new Set<string>();
    const run = (now: string) =>
      runDailySummary({
        getState: () => Promise.resolve(store.value),
        setState: (state) => {
          writes.push(state);
          store.value = state;
          return Promise.resolve();
        },
        summarizeDay: (range) => {
          summarized.push(range.label);
          if (range.label === options.failOnce && !failed.has(range.label)) {
            failed.add(range.label);
            return Promise.reject(new Error("aggregate failed"));
          }
          return Promise.resolve({
            result: resultFor(range),
            delivery: options.delivery?.(range) ?? SENT,
          });
        },
        sleep: () => Promise.resolve(),
        now: () => new Date(now),
        log,
      });
    return { run, store, summarized, writes, lines };
  }

  const NOW = "2026-10-14T00:05:00Z";
  const NEXT_DAY = "2026-10-15T00:05:00Z";

  test("rejects when a day older than yesterday was not sent", async () => {
    const { run } = setup({
      state: { last_day: "2026-10-11" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await expect(run(NOW)).rejects.toThrow("not delivered");
  });

  test("keeps the state of the days delivered before an older day", async () => {
    const { run, store } = setup({
      state: { last_day: "2026-10-10" },
      delivery: (range) =>
        range.label === "2026-10-12"
          ? { status: "not_sent", reason: "http 500" }
          : { status: "sent" },
    });
    await run(NOW).catch(() => undefined);
    expect(store.value).toEqual({ last_day: "2026-10-11" });
  });

  test("succeeds when only yesterday was not sent", async () => {
    const { run } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    const result = await run(NOW);
    expect(result.undelivered_day).toBe("2026-10-13");
  });

  test("keeps the state when only yesterday was not sent", async () => {
    const { run, store } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await run(NOW);
    expect(store.value).toEqual({ last_day: "2026-10-12" });
  });

  test("warns when only yesterday was not sent", async () => {
    const { run, lines } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await run(NOW);
    expect(lines.join("\n")).toContain("will be retried");
  });

  test("rejects when the day that was not sent yesterday is still not sent", async () => {
    const { run } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await run(NOW);
    await expect(run(NEXT_DAY)).rejects.toThrow("2026-10-13");
  });

  test("saves the day before the one that was not sent", async () => {
    const { run, store } = setup({
      state: null,
      delivery: () => ({ status: "not_sent", reason: "http 500" }),
    });
    await run(NOW);
    expect(store.value).toEqual({ last_day: "2026-10-12" });
  });

  // 記録なし、読めない値、未来の日付のいずれでも、
  // 届かなかった昨日が翌日の実行で昨日より古い日になることを確かめる。
  const NOT_SENT = { status: "not_sent", reason: "http 500" } as const;

  test("rejects the next run when yesterday was not sent and there was no state", async () => {
    const { run } = setup({ state: null, delivery: () => NOT_SENT });
    await run(NOW);
    await expect(run(NEXT_DAY)).rejects.toThrow("2026-10-13");
  });

  test("rejects the next run when yesterday was not sent and the state was unreadable", async () => {
    const { run } = setup({
      state: { last_day: "2026-02-30" },
      delivery: () => NOT_SENT,
    });
    await run(NOW);
    await expect(run(NEXT_DAY)).rejects.toThrow("2026-10-13");
  });

  test("rejects the next run when yesterday was not sent and the state was in the future", async () => {
    const { run } = setup({
      state: { last_day: "2026-10-20" },
      delivery: () => NOT_SENT,
    });
    await run(NOW);
    await expect(run(NEXT_DAY)).rejects.toThrow("2026-10-13");
  });

  // 集計が例外になった日は、stateが記録なし、読めない値、未来の日付のいずれでも、
  // 次の実行が同じ日から再開することを確かめる。
  const BROKEN_STATES: readonly [string, unknown][] = [
    ["there was no state", null],
    ["the state was unreadable", { last_day: "2026-02-30" }],
    ["the state was in the future", { last_day: "2026-10-20" }],
  ];

  for (const [name, state] of BROKEN_STATES) {
    test(`retries the same day in the next run when aggregation failed and ${name}`, async () => {
      const { run, summarized } = setup({ state, failOnce: "2026-10-13" });
      await run(NOW).catch(() => undefined);
      await run(NEXT_DAY);
      expect(summarized).toEqual(["2026-10-13", "2026-10-13", "2026-10-14"]);
    });

    test(`starts the next run from the same day when yesterday was not sent and ${name}`, async () => {
      const { run, summarized } = setup({ state, delivery: () => NOT_SENT });
      await run(NOW);
      await run(NEXT_DAY).catch(() => undefined);
      expect(summarized.slice(0, 2)).toEqual(["2026-10-13", "2026-10-13"]);
    });
  }

  test("does not write the state on a normal day when yesterday was not sent", async () => {
    const { run, writes } = setup({
      state: { last_day: "2026-10-12" },
      delivery: () => NOT_SENT,
    });
    await run(NOW);
    expect(writes).toEqual([]);
  });

  test("writes the state once on a normal day when yesterday was sent", async () => {
    const { run, writes } = setup({ state: { last_day: "2026-10-12" } });
    await run(NOW);
    expect(writes).toEqual([{ last_day: "2026-10-13" }]);
  });

  test("moves the state to the day before the window when days were skipped", async () => {
    const { run, store } = setup({
      state: { last_day: "2026-10-01" },
      delivery: (range) =>
        range.label === "2026-10-07" ? NOT_SENT : { status: "sent" },
    });
    await run(NOW).catch(() => undefined);
    expect(store.value).toEqual({ last_day: "2026-10-06" });
  });

  test("does not summarize anything when the state cannot be normalized", async () => {
    const { log } = captureLog();
    const summarized: string[] = [];
    const rejected = runDailySummary({
      getState: () => Promise.resolve(null),
      setState: () => Promise.reject(new Error("state write failed")),
      summarizeDay: (range) => {
        summarized.push(range.label);
        return Promise.resolve({ result: resultFor(range), delivery: SENT });
      },
      sleep: () => Promise.resolve(),
      now: () => new Date(NOW),
      log,
    }).catch(() => undefined);
    await rejected;
    expect(summarized).toEqual([]);
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
