import { describe, expect, test } from "bun:test";
import { logger } from "../../f/factory/lib/log.ts";
import { computeYesterdayRangeJst } from "../../f/factory/lib/summary_support.ts";
import type { WorkerLoadSummary } from "../../f/factory/lib/worker_load_support.ts";
import { readWorkerLoad } from "../../f/factory/notify_daily_summary.ts";

const RANGE = computeYesterdayRangeJst(new Date("2026-10-13T00:05:00Z"));

const SUMMARY: WorkerLoadSummary = {
  sample_count: 718,
  expected_count: 720,
  lag_max_seconds: 4,
  lag_over_count: 0,
  lag_over_total_seconds: 0,
  gap_count: 0,
  gap_longest_seconds: null,
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
