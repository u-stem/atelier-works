import { describe, expect, test } from "bun:test";
import { type Logger, logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import {
  DEFAULT_WORKER_SLOTS,
  WORKER_ALERT_SAMPLE_LIMIT,
  WORKER_LOAD_HIGH_KIND,
  type WorkerAlertSample,
  type WorkerAlertThresholds,
} from "../../f/factory/lib/worker_load_support.ts";
import {
  runSample,
  type SampleDeps,
} from "../../f/factory/sample_worker_load.ts";

const NOW = Date.parse("2026-10-15T03:10:30.000Z");
const SELF = "self-job";
const GIB = 1024 * 1024 * 1024;
const CONSOLE_URL = "http://127.0.0.1:8080/console/system";

const THRESHOLDS: WorkerAlertThresholds = { memoryRatio: 0.8 };

function selfJob() {
  return {
    id: SELF,
    running: true,
    job_kind: "script",
    tag: "bun",
    script_path: "f/factory/sample_worker_load",
    scheduled_for: "2026-10-15T03:10:30.000Z",
    started_at: "2026-10-15T03:10:31.000Z",
  };
}

function recentSample(
  overrides: Partial<WorkerAlertSample> = {},
): WorkerAlertSample {
  return {
    sampled_at: new Date(NOW),
    mem_anon_bytes: 0.1 * GIB,
    mem_limit_bytes: 4 * GIB,
    mem_events_max: 0,
    mem_oom_kill: 0,
    ...overrides,
  };
}

type Harness = {
  deps: SampleDeps;
  notices: NoticeRecord[];
  limits: number[];
  lines: string[];
};

function harness(
  recent: () => Promise<readonly WorkerAlertSample[]>,
  overrides: Partial<SampleDeps> = {},
  load: () => Promise<{
    thresholds: WorkerAlertThresholds;
    consoleUrl: string;
  }> = () =>
    Promise.resolve({ thresholds: THRESHOLDS, consoleUrl: CONSOLE_URL }),
): Harness {
  const notices: NoticeRecord[] = [];
  const limits: number[] = [];
  const lines: string[] = [];
  const log: Logger = logger("test", {
    sink: (line) => {
      lines.push(line);
    },
  });
  const deps: SampleDeps = {
    readCgroupFile: () => Promise.reject(new Error("ENOENT")),
    listRunning: () => Promise.resolve([selfJob()]),
    listWaiting: () => Promise.resolve([]),
    self: { id: SELF, getJob: () => Promise.resolve(selfJob()) },
    insertSample: () => Promise.resolve(7),
    getState: () => Promise.resolve({}),
    setState: () => Promise.resolve(),
    addNotice: (record) => {
      notices.push(record);
      return Promise.resolve(1);
    },
    resolveNotice: () => Promise.resolve(0),
    alerts: {
      load,
      listRecent: (limit) => {
        limits.push(limit);
        return recent();
      },
    },
    now: () => NOW,
    slots: DEFAULT_WORKER_SLOTS,
    log,
    ...overrides,
  };
  return { deps, notices, limits, lines };
}

describe("runSample load alerts", () => {
  test("adds no notice when the load is low", async () => {
    const h = harness(() => Promise.resolve([recentSample()]));
    await runSample(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("adds a worker_load_high notice when the memory is high", async () => {
    const h = harness(() =>
      Promise.resolve([recentSample({ mem_anon_bytes: 3.5 * GIB })]),
    );
    await runSample(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      WORKER_LOAD_HIGH_KIND,
    ]);
  });

  test("links the system screen in the notice", async () => {
    const h = harness(() =>
      Promise.resolve([recentSample({ mem_anon_bytes: 3.5 * GIB })]),
    );
    await runSample(h.deps);
    expect(h.notices[0]?.message).toContain(CONSOLE_URL);
  });

  test("adds one notice per cause", async () => {
    const h = harness(() =>
      Promise.resolve([
        recentSample({ mem_anon_bytes: 3.5 * GIB, mem_oom_kill: 1 }),
        recentSample(),
      ]),
    );
    await runSample(h.deps);
    expect(h.notices.length).toBe(2);
  });

  test("reads only the samples that the window needs", async () => {
    const h = harness(() => Promise.resolve([recentSample()]));
    await runSample(h.deps);
    expect(h.limits).toEqual([WORKER_ALERT_SAMPLE_LIMIT]);
  });

  test("skips the check when the row could not be recorded", async () => {
    const h = harness(() => Promise.resolve([recentSample()]), {
      insertSample: () => Promise.reject(new Error("db down")),
    });
    await runSample(h.deps);
    expect(h.limits).toEqual([]);
  });

  test("skips the check when the alerts are not wired", async () => {
    const h = harness(() =>
      Promise.resolve([recentSample({ mem_anon_bytes: 3.5 * GIB })]),
    );
    const { alerts: _unwired, ...withoutAlerts } = h.deps;
    await runSample(withoutAlerts);
    expect(h.notices).toEqual([]);
  });

  test("keeps the outcome when the recent samples could not be read", async () => {
    const h = harness(() => Promise.reject(new Error("db down")));
    const result = await runSample(h.deps);
    expect(result.outcome).toBe("partial");
  });

  test("warns when the recent samples could not be read", async () => {
    const h = harness(() => Promise.reject(new Error("db down")));
    await runSample(h.deps);
    expect(
      h.lines.some((line) => line.includes("could not check the load alerts")),
    ).toBe(true);
  });

  test("keeps the outcome when the thresholds could not be loaded", async () => {
    const h = harness(
      () => Promise.resolve([recentSample()]),
      {},
      () => Promise.reject(new Error("config invalid")),
    );
    const result = await runSample(h.deps);
    expect(result.outcome).toBe("partial");
  });

  test("keeps going when one notice could not be added", async () => {
    let calls = 0;
    const h = harness(
      () =>
        Promise.resolve([
          recentSample({ mem_anon_bytes: 3.5 * GIB, mem_oom_kill: 1 }),
          recentSample(),
        ]),
      {
        addNotice: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("db down"))
            : Promise.resolve(2);
        },
      },
    );
    await runSample(h.deps);
    expect(calls).toBe(2);
  });
});
