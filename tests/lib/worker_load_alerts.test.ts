import { describe, expect, test } from "bun:test";
import {
  evaluateWorkerAlerts,
  WORKER_LOAD_HIGH_KIND,
  type WorkerAlertSample,
  type WorkerAlertThresholds,
  workerAlertNotice,
} from "../../f/factory/lib/worker_load_support.ts";

const THRESHOLDS: WorkerAlertThresholds = { memoryRatio: 0.8 };

const NEWEST = Date.parse("2026-10-15T12:00:00.000Z");
const MINUTE_MS = 60_000;
const GIB = 1024 * 1024 * 1024;

/** `index`が0のものが最新で、2分ずつ過去に遡る。 */
function sample(
  index: number,
  overrides: Partial<WorkerAlertSample> = {},
): WorkerAlertSample {
  return {
    sampled_at: new Date(NEWEST - index * 2 * MINUTE_MS),
    mem_anon_bytes: 0.1 * GIB,
    mem_limit_bytes: 4 * GIB,
    mem_oom_kill: 0,
    ...overrides,
  };
}

describe("evaluateWorkerAlerts memory", () => {
  test("is quiet when the memory is far below the limit", () => {
    expect(evaluateWorkerAlerts([sample(0), sample(1)], THRESHOLDS)).toEqual(
      [],
    );
  });

  test("raises memory when the anon memory reaches the ratio", () => {
    const samples = [sample(0, { mem_anon_bytes: 3.2 * GIB }), sample(1)];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["memory"]);
  });

  test("is quiet just below the ratio", () => {
    const samples = [sample(0, { mem_anon_bytes: 3.1 * GIB })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the limit could not be read", () => {
    const samples = [
      sample(0, { mem_anon_bytes: 3.9 * GIB, mem_limit_bytes: null }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the limit is zero", () => {
    const samples = [
      sample(0, { mem_anon_bytes: 3.9 * GIB, mem_limit_bytes: 0 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the anon memory could not be read", () => {
    const samples = [sample(0, { mem_anon_bytes: null })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("judges the ratio on the newest sample only", () => {
    const samples = [sample(0), sample(1, { mem_anon_bytes: 3.9 * GIB })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });
});

describe("evaluateWorkerAlerts oom kill", () => {
  test("raises oom_kill when the count grew since the previous sample", () => {
    const samples = [sample(0, { mem_oom_kill: 1 }), sample(1)];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["oom_kill"]);
  });

  test("is quiet when the count stayed the same", () => {
    const samples = [
      sample(0, { mem_oom_kill: 3 }),
      sample(1, { mem_oom_kill: 3 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("compares with the latest readable sample when the previous one is unreadable", () => {
    const samples = [
      sample(0, { mem_oom_kill: 2 }),
      sample(1, { mem_oom_kill: null }),
      sample(2, { mem_oom_kill: 1 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["oom_kill"]);
  });

  test("is quiet when there is nothing to compare with", () => {
    expect(
      evaluateWorkerAlerts([sample(0, { mem_oom_kill: 5 })], THRESHOLDS),
    ).toEqual([]);
  });

  test("compares across an hour of unreadable samples", () => {
    const unreadable = Array.from({ length: 28 }, (_, index) =>
      sample(index + 1, { mem_oom_kill: null }),
    );
    const samples = [
      sample(0, { mem_oom_kill: 1 }),
      ...unreadable,
      sample(29, { mem_oom_kill: 0 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["oom_kill"]);
  });

  test("is quiet when the newest count could not be read", () => {
    const samples = [sample(0, { mem_oom_kill: null }), sample(1)];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("raises oom_kill after a restart when the new count is positive", () => {
    const samples = [
      sample(0, { mem_oom_kill: 1 }),
      sample(1, { mem_oom_kill: 4 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["oom_kill"]);
  });

  test("is quiet after a restart when the new count is zero", () => {
    const samples = [
      sample(0, { mem_oom_kill: 0 }),
      sample(1, { mem_oom_kill: 4 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("does not raise again once the count stopped growing", () => {
    const samples = [
      sample(0, { mem_oom_kill: 1 }),
      sample(1, { mem_oom_kill: 1 }),
      sample(2, { mem_oom_kill: 0 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });
});

describe("evaluateWorkerAlerts causes together", () => {
  test("lists every cause that applies", () => {
    const samples = [
      sample(0, { mem_anon_bytes: 3.5 * GIB, mem_oom_kill: 1 }),
      sample(1),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([
      "memory",
      "oom_kill",
    ]);
  });

  test("is quiet without samples", () => {
    expect(evaluateWorkerAlerts([], THRESHOLDS)).toEqual([]);
  });
});

describe("workerAlertNotice", () => {
  const URL = "http://127.0.0.1:8080/console/system";

  test("uses the worker_load_high kind", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL).kind).toBe(
      WORKER_LOAD_HIGH_KIND,
    );
  });

  test("carries the link to the system screen", () => {
    expect(workerAlertNotice("oom_kill", THRESHOLDS, URL).message).toContain(
      URL,
    );
  });

  test("carries the next action", () => {
    expect(workerAlertNotice("oom_kill", THRESHOLDS, URL).message).toContain(
      "次の操作:",
    );
  });

  test("shows the threshold of the memory ratio as a percentage", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL).message).toContain(
      "80%",
    );
  });

  test("shows a ratio that rounds to zero with one decimal", () => {
    expect(
      workerAlertNotice("memory", { memoryRatio: 0.001 }, URL).message,
    ).toContain("0.1%");
  });

  test("keeps the text equal across calls so a repeat is not notified twice", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL)).toEqual(
      workerAlertNotice("memory", THRESHOLDS, URL),
    );
  });

  test("differs between the causes", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL).message).not.toBe(
      workerAlertNotice("oom_kill", THRESHOLDS, URL).message,
    );
  });
});
