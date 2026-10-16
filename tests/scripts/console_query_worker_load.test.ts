import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  runSystemStatus,
  type SystemStatusDeps,
} from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

const NOW = new Date("2026-10-15T12:00:00.000Z");
const SINCE = "2026-10-14T12:00:00.000Z";

/** worker_loadの問い合わせは、5番目に発行される。 */
const WORKER_LOAD_INDEX = 4;

const ROW: SqlRow = {
  sample_count: "700",
  max_running_jobs: "2",
  max_waiting_jobs: "3",
  max_wait_seconds: "45",
  max_lag_seconds: "12",
  max_mem_current_bytes: "400000000",
  max_mem_anon_bytes: "180000000",
  max_mem_anon_ratio: 0.042,
  max_mem_working_set_bytes: "200000000",
  max_mem_peak_bytes: "1371127808",
  running_readable_samples: "690",
  busy_samples: "7",
  lag_over_samples: "10",
  latest_sampled_at: new Date("2026-10-15T11:58:30.000Z"),
  latest_slots: 3,
  latest_running_jobs: "1",
  latest_waiting_jobs: "0",
  latest_max_wait_seconds: "0",
  latest_lag_seconds: "1",
  latest_mem_current_bytes: "323907584",
  latest_mem_anon_bytes: "80125952",
  latest_mem_working_set_bytes: "273625088",
  latest_mem_peak_bytes: "1371127808",
  latest_mem_limit_bytes: "4294967296",
};

function deps(
  workerLoadRows: SqlRow[],
  failWith?: Error,
): { deps: SystemStatusDeps; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let index = 0;
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const current = index;
    index += 1;
    return {
      fetch: () =>
        current === WORKER_LOAD_INDEX && failWith !== undefined
          ? Promise.reject(failWith)
          : Promise.resolve(
              current === WORKER_LOAD_INDEX ? workerLoadRows : [],
            ),
      execute: () => Promise.resolve(),
    };
  };
  return {
    calls,
    deps: {
      sql,
      readFile: async () => {
        throw new Error("ENOENT");
      },
      getVariable: async () => "",
      now: () => NOW,
    },
  };
}

describe("runSystemStatus worker load query", () => {
  test("reads the worker samples", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.text).toContain(
      "FROM factory.worker_samples",
    );
  });

  test("limits the samples to the last 24 hours", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.values).toContain(SINCE);
  });

  test("takes the newest sample as the latest value", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.text).toContain(
      "ORDER BY sampled_at DESC, id DESC",
    );
  });
});

describe("runSystemStatus worker load result", () => {
  test("returns null when no sample is in the window", async () => {
    const d = deps([{ ...ROW, sample_count: "0" }]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load).toBeNull();
  });

  test("returns null when the query returns no row", async () => {
    const d = deps([]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load).toBeNull();
  });

  test("returns null and keeps the screen when the query fails", async () => {
    const d = deps([ROW], new Error("relation does not exist"));
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load).toBeNull();
  });

  test("counts the samples against the day's expected number", async () => {
    const d = deps([ROW]);
    const status = await runSystemStatus(200, d.deps);
    expect([
      status.worker_load?.sample_count,
      status.worker_load?.expected_count,
    ]).toEqual([700, 720]);
  });

  test("returns the latest memory and the peak", async () => {
    const d = deps([ROW]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load?.latest).toEqual({
      sampled_at: "2026-10-15T11:58:30.000Z",
      slots: 3,
      running_jobs: 1,
      waiting_jobs: 0,
      max_wait_seconds: 0,
      lag_seconds: 1,
      mem_current_bytes: 323907584,
      mem_anon_bytes: 80125952,
      mem_working_set_bytes: 273625088,
      mem_peak_bytes: 1371127808,
      mem_limit_bytes: 4294967296,
    });
  });

  test("returns the maximum of the window", async () => {
    const d = deps([ROW]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load?.max).toEqual({
      running_jobs: 2,
      waiting_jobs: 3,
      max_wait_seconds: 45,
      lag_seconds: 12,
      mem_current_bytes: 400000000,
      mem_anon_bytes: 180000000,
      mem_anon_ratio: 0.042,
      mem_working_set_bytes: 200000000,
      mem_peak_bytes: 1371127808,
    });
  });

  test("returns the counts of busy and late samples", async () => {
    const d = deps([ROW]);
    const status = await runSystemStatus(200, d.deps);
    expect([
      status.worker_load?.busy_samples,
      status.worker_load?.lag_over_samples,
    ]).toEqual([7, 10]);
  });

  test("counts the samples whose running jobs were readable", async () => {
    const d = deps([ROW]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.worker_load?.running_readable_samples).toBe(690);
  });

  test("counts the readable running jobs in SQL, leaving out unreadable rows", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.text).toContain("count(running_jobs)");
  });

  test("counts a busy sample only when the sample had a slot for other jobs", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.text).toContain(
      "WHERE slots > 1 AND running_jobs >= slots - 1",
    );
  });

  test("leaves the samples without a slot for other jobs out of the readable count", async () => {
    const d = deps([ROW]);
    await runSystemStatus(200, d.deps);
    expect(d.calls[WORKER_LOAD_INDEX]?.text).toContain(
      "count(running_jobs) FROM recent WHERE slots > 1",
    );
  });

  test("keeps a value that could not be read as null", async () => {
    const d = deps([
      { ...ROW, latest_mem_anon_bytes: null, max_mem_anon_ratio: null },
    ]);
    const status = await runSystemStatus(200, d.deps);
    expect([
      status.worker_load?.latest.mem_anon_bytes,
      status.worker_load?.max.mem_anon_ratio,
    ]).toEqual([null, null]);
  });
});
