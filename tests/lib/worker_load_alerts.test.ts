import { describe, expect, test } from "bun:test";
import {
  evaluateWorkerAlerts,
  WORKER_ALERT_MIN_SAMPLES,
  WORKER_ALERT_WINDOW_MINUTES,
  WORKER_LOAD_HIGH_KIND,
  type WorkerAlertSample,
  type WorkerAlertThresholds,
  workerAlertNotice,
} from "../../f/factory/lib/worker_load_support.ts";

const THRESHOLDS: WorkerAlertThresholds = {
  memoryRatio: 0.8,
  waitSeconds: 300,
  busyRatio: 0.5,
};

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
    slots: 3,
    running_jobs: 0,
    max_wait_seconds: 0,
    mem_anon_bytes: 0.1 * GIB,
    mem_limit_bytes: 4 * GIB,
    ...overrides,
  };
}

function quiet(count: number): WorkerAlertSample[] {
  return Array.from({ length: count }, (_, index) => sample(index));
}

describe("evaluateWorkerAlerts memory", () => {
  test("is quiet when the memory is far below the limit", () => {
    expect(evaluateWorkerAlerts(quiet(3), THRESHOLDS)).toEqual([]);
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

  test("is quiet when the anon memory could not be read", () => {
    const samples = [sample(0, { mem_anon_bytes: null })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("judges the newest sample only", () => {
    const samples = [sample(0), sample(1, { mem_anon_bytes: 3.9 * GIB })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });
});

describe("evaluateWorkerAlerts wait", () => {
  test("raises wait when another job holds a slot and the wait is long", () => {
    const samples = [sample(0, { running_jobs: 1, max_wait_seconds: 300 })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["wait"]);
  });

  test("is quiet when the wait is just below the threshold", () => {
    const samples = [sample(0, { running_jobs: 1, max_wait_seconds: 299 })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when no other job runs, as after a host sleep", () => {
    const samples = [sample(0, { running_jobs: 0, max_wait_seconds: 12_000 })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the running jobs could not be read", () => {
    const samples = [
      sample(0, { running_jobs: null, max_wait_seconds: 12_000 }),
    ];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the wait could not be read", () => {
    const samples = [sample(0, { running_jobs: 2, max_wait_seconds: null })];
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });
});

describe("evaluateWorkerAlerts busy", () => {
  function busyWindow(busy: number, total: number): WorkerAlertSample[] {
    return Array.from({ length: total }, (_, index) =>
      sample(index, { running_jobs: index < busy ? 2 : 0 }),
    );
  }

  test("raises busy when half of the window had every other slot taken", () => {
    expect(evaluateWorkerAlerts(busyWindow(15, 30), THRESHOLDS)).toEqual([
      "busy",
    ]);
  });

  test("is quiet when less than the ratio was busy", () => {
    expect(evaluateWorkerAlerts(busyWindow(14, 30), THRESHOLDS)).toEqual([]);
  });

  test("does not count a sample that left a slot free", () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample(index, { running_jobs: 1 }),
    );
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual([]);
  });

  test("is quiet when the window has too few samples", () => {
    const few = WORKER_ALERT_MIN_SAMPLES - 1;
    expect(evaluateWorkerAlerts(busyWindow(few, few), THRESHOLDS)).toEqual([]);
  });

  test("raises busy at the minimum number of samples", () => {
    const enough = WORKER_ALERT_MIN_SAMPLES;
    expect(
      evaluateWorkerAlerts(busyWindow(enough, enough), THRESHOLDS),
    ).toEqual(["busy"]);
  });

  test("ignores samples older than the window", () => {
    const old = Array.from({ length: 20 }, (_, index) =>
      sample(WORKER_ALERT_WINDOW_MINUTES / 2 + 1 + index, { running_jobs: 2 }),
    );
    const recent = Array.from({ length: 12 }, (_, index) => sample(index));
    expect(evaluateWorkerAlerts([...recent, ...old], THRESHOLDS)).toEqual([]);
  });

  test("skips samples whose running jobs could not be read", () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample(index, { running_jobs: index < 15 ? 2 : null }),
    );
    expect(evaluateWorkerAlerts(samples, THRESHOLDS)).toEqual(["busy"]);
  });
});

describe("evaluateWorkerAlerts without samples", () => {
  test("is quiet", () => {
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
    expect(workerAlertNotice("wait", THRESHOLDS, URL).message).toContain(URL);
  });

  test("carries the next action", () => {
    expect(workerAlertNotice("busy", THRESHOLDS, URL).message).toContain(
      "次の操作:",
    );
  });

  test("shows the threshold of the memory ratio as a percentage", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL).message).toContain(
      "80%",
    );
  });

  test("shows the threshold of the wait in minutes", () => {
    expect(workerAlertNotice("wait", THRESHOLDS, URL).message).toContain("5分");
  });

  test("keeps the text equal across calls so a repeat is not notified twice", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL)).toEqual(
      workerAlertNotice("memory", THRESHOLDS, URL),
    );
  });

  test("differs between the causes", () => {
    expect(workerAlertNotice("memory", THRESHOLDS, URL).message).not.toBe(
      workerAlertNotice("busy", THRESHOLDS, URL).message,
    );
  });
});
