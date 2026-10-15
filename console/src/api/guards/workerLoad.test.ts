import { describe, expect, test } from "bun:test";
import { isSystemStatus } from "./systemStatus.ts";
import { isWorkerLoad } from "./workerLoad.ts";

const LOAD = {
  window_hours: 24,
  sample_count: 700,
  expected_count: 720,
  latest: {
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
  },
  max: {
    running_jobs: 2,
    waiting_jobs: 3,
    max_wait_seconds: 45,
    lag_seconds: 12,
    mem_current_bytes: 400000000,
    mem_anon_bytes: 180000000,
    mem_anon_ratio: 0.042,
    mem_working_set_bytes: 200000000,
    mem_peak_bytes: 1371127808,
  },
  running_readable_samples: 690,
  busy_samples: 7,
  lag_over_samples: 10,
};

const STATUS = {
  deployed_sha: null,
  deployment: null,
  fetcher: { availability: "unavailable", reason: "missing" },
  orphan_failures: [],
  info_notices: [],
  resolved_notices: [],
};

describe("isWorkerLoad", () => {
  test("accepts a complete value", () => {
    expect(isWorkerLoad(LOAD)).toBe(true);
  });

  test("accepts values that could not be read", () => {
    const unreadable = {
      ...LOAD,
      latest: { ...LOAD.latest, mem_anon_bytes: null, mem_limit_bytes: null },
      max: { ...LOAD.max, mem_anon_ratio: null },
    };
    expect(isWorkerLoad(unreadable)).toBe(true);
  });

  test("rejects a value that is not an object", () => {
    expect(isWorkerLoad("load")).toBe(false);
  });

  test("rejects a latest sample with an unreadable time", () => {
    const damaged = { ...LOAD, latest: { ...LOAD.latest, sampled_at: "soon" } };
    expect(isWorkerLoad(damaged)).toBe(false);
  });

  test("rejects a count that is not a number", () => {
    expect(isWorkerLoad({ ...LOAD, busy_samples: "7" })).toBe(false);
  });

  test("rejects a maximum that lost a key", () => {
    const { mem_peak_bytes: _lost, ...max } = LOAD.max;
    expect(isWorkerLoad({ ...LOAD, max })).toBe(false);
  });

  test("rejects a number that is not finite", () => {
    const damaged = {
      ...LOAD,
      max: { ...LOAD.max, mem_anon_ratio: Number.NaN },
    };
    expect(isWorkerLoad(damaged)).toBe(false);
  });

  test("rejects a worker load that lost the readable running count", () => {
    const { running_readable_samples: _lost, ...older } = LOAD;
    expect(isWorkerLoad(older)).toBe(false);
  });
});

describe("isSystemStatus with worker_load", () => {
  test("accepts a status from a backend that does not send worker_load yet", () => {
    expect(isSystemStatus(STATUS)).toBe(true);
  });

  test("accepts a status with no worker load recorded", () => {
    expect(isSystemStatus({ ...STATUS, worker_load: null })).toBe(true);
  });

  test("accepts a status with a worker load", () => {
    expect(isSystemStatus({ ...STATUS, worker_load: LOAD })).toBe(true);
  });

  test("keeps the status when the worker load has a different shape", () => {
    const damaged = { ...STATUS, worker_load: { ...LOAD, sample_count: "x" } };
    expect(isSystemStatus(damaged)).toBe(true);
  });
});
