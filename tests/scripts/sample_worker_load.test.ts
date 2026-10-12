import { describe, expect, test } from "bun:test";
import type { NewWorkerSample } from "../../f/factory/lib/db.ts";
import { type Logger, logger } from "../../f/factory/lib/log.ts";
import { CallTimeoutError } from "../../f/factory/lib/self_update_support.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import {
  DEFAULT_WORKER_SLOTS,
  WORKER_SAMPLE_FAILED_NOTICE,
  WORKER_SAMPLE_FAILURE_LIMIT,
  WORKER_SAMPLE_QUEUE_PER_PAGE,
} from "../../f/factory/lib/worker_load_support.ts";
import {
  deadlineCaller,
  runSample,
  SAMPLE_DEADLINE_MS,
  type SampleDeps,
} from "../../f/factory/sample_worker_load.ts";

const NOW = Date.parse("2026-10-12T03:10:30.000Z");
const SELF = "self-job";

const CGROUP_FILES: Record<string, string> = {
  "memory.current": "323907584\n",
  "memory.peak": "1371127808\n",
  "memory.max": "4294967296\n",
  "memory.stat": "anon 80125952\ninactive_file 50282496\n",
  "memory.events": "low 0\nhigh 0\nmax 4\noom 0\noom_kill 0\n",
};

function selfJob(extra: Record<string, unknown> = {}) {
  return {
    id: SELF,
    running: true,
    job_kind: "script",
    tag: "bun",
    script_path: "f/factory/sample_worker_load",
    scheduled_for: "2026-10-12T03:10:30.000Z",
    started_at: "2026-10-12T03:10:31.000Z",
    ...extra,
  };
}

function other(path: string, extra: Record<string, unknown> = {}) {
  return {
    id: `job-${path}`,
    running: true,
    job_kind: "script",
    tag: "bun",
    script_path: path,
    ...extra,
  };
}

type Harness = {
  deps: SampleDeps;
  samples: NewWorkerSample[];
  notices: NoticeRecord[];
  resolved: NoticeRecord[];
  selfReads: { count: number };
  states: Record<string, unknown>[];
  warnings: string[];
};

function harness(overrides: Partial<SampleDeps> = {}): Harness {
  const samples: NewWorkerSample[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: NoticeRecord[] = [];
  const selfReads = { count: 0 };
  const states: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const log: Logger = logger("test", {
    sink: (line) => {
      warnings.push(line);
    },
  });
  const deps: SampleDeps = {
    readCgroupFile: (name) => {
      const text = CGROUP_FILES[name];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${name}`))
        : Promise.resolve(text);
    },
    listRunning: () =>
      Promise.resolve([selfJob(), other("f/factory/poll_prs")]),
    listWaiting: () => Promise.resolve([]),
    self: {
      id: SELF,
      getJob: () => {
        selfReads.count += 1;
        return Promise.resolve(selfJob());
      },
    },
    insertSample: (sample) => {
      samples.push(sample);
      return Promise.resolve(7);
    },
    getState: () => Promise.resolve({}),
    setState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
    addNotice: (record) => {
      notices.push(record);
      return Promise.resolve(1);
    },
    resolveNotice: (record) => {
      resolved.push(record);
      return Promise.resolve(1);
    },
    now: () => NOW,
    slots: DEFAULT_WORKER_SLOTS,
    log,
    ...overrides,
  };
  return { deps, samples, notices, resolved, selfReads, states, warnings };
}

describe("runSample record", () => {
  test("records the running jobs without the sampling job itself", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBe(1);
  });

  test("records the running jobs per script", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]?.running_by_script).toEqual({
      "f/factory/poll_prs": 1,
    });
  });

  test("records the waiting jobs", async () => {
    const h = harness({
      listWaiting: () =>
        Promise.resolve([
          {
            id: "w",
            running: false,
            job_kind: "script",
            tag: "bun",
            scheduled_for: "2026-10-12T03:08:30.000Z",
          },
        ]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.waiting_jobs).toBe(1);
  });

  test("records the longest wait in seconds", async () => {
    const h = harness({
      listWaiting: () =>
        Promise.resolve([
          {
            id: "w",
            running: false,
            job_kind: "script",
            tag: "bun",
            scheduled_for: "2026-10-12T03:08:30.000Z",
          },
        ]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.max_wait_seconds).toBe(120);
  });

  test("records the delay from the scheduled time to the start", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]?.lag_seconds).toBe(1);
  });

  test("records the scheduled time of the sampling job", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]?.scheduled_for?.toISOString()).toBe(
      "2026-10-12T03:10:30.000Z",
    );
  });

  test("records the configured slots", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]?.slots).toBe(DEFAULT_WORKER_SLOTS);
  });

  test("records the memory values read from the cgroup", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.samples[0]).toMatchObject({
      mem_current_bytes: 323907584,
      mem_anon_bytes: 80125952,
      mem_working_set_bytes: 323907584 - 50282496,
      mem_peak_bytes: 1371127808,
      mem_limit_bytes: 4294967296,
      mem_events_max: 4,
    });
  });

  test("logs the sample even when the row cannot be recorded", async () => {
    const h = harness({
      insertSample: () => Promise.reject(new Error("db down")),
    });
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes('"worker sample"'))).toBe(
      true,
    );
  });

  test("returns the id of the recorded row", async () => {
    const h = harness();
    expect((await runSample(h.deps)).sample_id).toBe(7);
  });
});

describe("runSample own row", () => {
  test("falls back to the job itself when the running list lacks it", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([other("f/factory/poll_prs")]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.lag_seconds).toBe(1);
  });

  test("falls back to the job itself when the running list lacks its start time", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([selfJob({ started_at: undefined })]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.lag_seconds).toBe(1);
  });

  test("leaves the delay null when neither source has it", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([]),
      self: { id: SELF, getJob: () => Promise.reject(new Error("not found")) },
    });
    await runSample(h.deps);
    expect(h.samples[0]?.lag_seconds).toBeNull();
  });

  test("does not read the job itself when the running list has it", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.selfReads.count).toBe(0);
  });

  test("does not read the job itself when the running list failed", async () => {
    const h = harness({
      listRunning: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.selfReads.count).toBe(0);
  });

  test("leaves the delay null outside a job", async () => {
    const h = harness({ self: null });
    await runSample(h.deps);
    expect(h.samples[0]?.lag_seconds).toBeNull();
  });
});

describe("runSample partial reads", () => {
  test("still records the memory when the running list fails", async () => {
    const h = harness({
      listRunning: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.mem_current_bytes).toBe(323907584);
  });

  test("leaves the running jobs null when the running list fails", async () => {
    const h = harness({
      listRunning: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBeNull();
  });

  test("leaves the waiting jobs null when the response is not a list", async () => {
    const h = harness({
      listWaiting: () => Promise.resolve({ error: "forbidden" }),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.waiting_jobs).toBeNull();
  });

  test("still records the queue when the cgroup is unreadable", async () => {
    const h = harness({
      readCgroupFile: () => Promise.reject(new Error("EACCES")),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBe(1);
  });

  test("leaves the memory null when the cgroup files are empty", async () => {
    const h = harness({ readCgroupFile: () => Promise.resolve("") });
    await runSample(h.deps);
    expect(h.samples[0]?.mem_current_bytes).toBeNull();
  });

  test("leaves the peak null when memory.peak is missing", async () => {
    const files = { ...CGROUP_FILES };
    delete files["memory.peak"];
    const h = harness({
      readCgroupFile: (name) => {
        const text = files[name];
        return text === undefined
          ? Promise.reject(new Error("ENOENT"))
          : Promise.resolve(text);
      },
    });
    await runSample(h.deps);
    expect(h.samples[0]?.mem_peak_bytes).toBeNull();
  });

  test("warns about an unreadable required cgroup file", async () => {
    const h = harness({
      readCgroupFile: () => Promise.reject(new Error("EACCES")),
    });
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes("memory.current"))).toBe(
      true,
    );
  });

  test("does not warn about a missing memory.pressure", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes("memory.pressure"))).toBe(
      false,
    );
  });
});

describe("runSample response shape", () => {
  test("leaves the running jobs null when a short list lacks the sampling job", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([other("f/factory/poll_prs")]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBeNull();
  });

  test("leaves the per-script counts null when a short list lacks the sampling job", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([other("f/factory/poll_prs")]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.running_by_script).toBeNull();
  });

  test("keeps the running jobs when a full page lacks the sampling job", async () => {
    const page = Array.from({ length: WORKER_SAMPLE_QUEUE_PER_PAGE }, (_, i) =>
      other(`f/factory/s${String(i)}`, { id: `job-${String(i)}` }),
    );
    const h = harness({ listRunning: () => Promise.resolve(page) });
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBe(WORKER_SAMPLE_QUEUE_PER_PAGE);
  });

  test("leaves the running jobs null when the sampling job has no readable tag", async () => {
    const h = harness({
      listRunning: () =>
        Promise.resolve([selfJob({ tag: undefined }), other("f/factory/a")]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.running_jobs).toBeNull();
  });

  test("warns when the sampling job is not readable in the running list", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([other("f/factory/poll_prs")]),
    });
    await runSample(h.deps);
    expect(
      h.warnings.some((line) => line.includes("sampling job is not readable")),
    ).toBe(true);
  });

  test("warns about a running element of an unexpected shape", async () => {
    const h = harness({
      listRunning: () =>
        Promise.resolve([selfJob(), other("f/factory/a", { tag: 3 })]),
    });
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes("unexpected shape"))).toBe(
      true,
    );
  });

  test("warns about a waiting element of an unexpected shape", async () => {
    const h = harness({
      listWaiting: () =>
        Promise.resolve([
          { id: "w", running: false, job_kind: "script", tag: "bun" },
        ]),
    });
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes("unexpected shape"))).toBe(
      true,
    );
  });

  test("does not warn when every element has the expected shape", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.warnings.some((line) => line.includes("unexpected shape"))).toBe(
      false,
    );
  });

  test("leaves the waiting jobs null when no element has the expected shape", async () => {
    const h = harness({
      listWaiting: () => Promise.resolve([{ unexpected: true }]),
    });
    await runSample(h.deps);
    expect(h.samples[0]?.waiting_jobs).toBeNull();
  });
});

describe("runSample outcome", () => {
  test("is complete when everything was read, even without memory.pressure", async () => {
    const h = harness();
    expect((await runSample(h.deps)).outcome).toBe("complete");
  });

  test("is partial when the queue could not be read", async () => {
    const h = harness({
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is partial when memory.current could not be read", async () => {
    const h = harness({ readCgroupFile: () => Promise.resolve("") });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is partial when the sampling job is missing from a short running list", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([other("f/factory/poll_prs")]),
    });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is partial when anon could not be read", async () => {
    const h = harness({
      readCgroupFile: (name) =>
        name === "memory.stat"
          ? Promise.resolve("inactive_file 1\n")
          : Promise.resolve(CGROUP_FILES[name] ?? ""),
    });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is partial when the delay could not be read", async () => {
    const h = harness({
      listRunning: () => Promise.resolve([selfJob({ started_at: undefined })]),
      self: { id: SELF, getJob: () => Promise.reject(new Error("not found")) },
    });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is partial when the scheduled time could not be read", async () => {
    const h = harness({
      listRunning: () =>
        Promise.resolve([selfJob({ scheduled_for: undefined })]),
      self: {
        id: SELF,
        getJob: () => Promise.resolve(selfJob({ scheduled_for: undefined })),
      },
    });
    expect((await runSample(h.deps)).outcome).toBe("partial");
  });

  test("is failed when the row could not be recorded", async () => {
    const h = harness({
      insertSample: () => Promise.reject(new Error("db down")),
    });
    expect((await runSample(h.deps)).outcome).toBe("failed");
  });

  test("does not throw when the row could not be recorded", async () => {
    const h = harness({
      insertSample: () => Promise.reject(new Error("db down")),
    });
    await expect(runSample(h.deps)).resolves.toBeDefined();
  });
});

describe("runSample failure count", () => {
  test("starts counting after an incomplete run", async () => {
    const h = harness({
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.states).toEqual([{ worker_sample_failure_count: 1 }]);
  });

  test("keeps the other keys of the state", async () => {
    const h = harness({
      getState: () => Promise.resolve({ other: "kept" }),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.states[0]?.other).toBe("kept");
  });

  test("adds one to the saved count", async () => {
    const h = harness({
      getState: () => Promise.resolve({ worker_sample_failure_count: 2 }),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.states[0]?.worker_sample_failure_count).toBe(3);
  });

  test("resets the count after a complete run", async () => {
    const h = harness({
      getState: () => Promise.resolve({ worker_sample_failure_count: 2 }),
    });
    await runSample(h.deps);
    expect(h.states[0]?.worker_sample_failure_count).toBe(0);
  });

  test("does not write the state when the count stays at zero", async () => {
    const h = harness();
    await runSample(h.deps);
    expect(h.states).toEqual([]);
  });

  test("does not write the state when it could not be read", async () => {
    const h = harness({
      getState: () => Promise.reject(new Error("state down")),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.states).toEqual([]);
  });

  test("counts a run whose row could not be recorded", async () => {
    const h = harness({
      insertSample: () => Promise.reject(new Error("db down")),
    });
    await runSample(h.deps);
    expect(h.states[0]?.worker_sample_failure_count).toBe(1);
  });

  test("does not raise a notice below the limit", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT - 2,
        }),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("raises the notice when the count reaches the limit", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT - 1,
        }),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.notices).toEqual([WORKER_SAMPLE_FAILED_NOTICE]);
  });

  test("raises the notice even when the state could not be written", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT,
        }),
      setState: () => Promise.reject(new Error("state down")),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.notices).toEqual([WORKER_SAMPLE_FAILED_NOTICE]);
  });

  test("does not throw when the notice could not be recorded", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT,
        }),
      addNotice: () => Promise.reject(new Error("db down")),
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await expect(runSample(h.deps)).resolves.toBeDefined();
  });
});

describe("runSample recovery", () => {
  const limitReached = () =>
    Promise.resolve({
      worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT,
    });

  test("resolves the notice when a complete run follows enough failures", async () => {
    const h = harness({ getState: limitReached });
    await runSample(h.deps);
    expect(h.resolved).toEqual([WORKER_SAMPLE_FAILED_NOTICE]);
  });

  test("resets the count after resolving the notice", async () => {
    const h = harness({ getState: limitReached });
    await runSample(h.deps);
    expect(h.states[0]?.worker_sample_failure_count).toBe(0);
  });

  test("does not resolve the notice below the limit", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          worker_sample_failure_count: WORKER_SAMPLE_FAILURE_LIMIT - 1,
        }),
    });
    await runSample(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not resolve the notice after an incomplete run", async () => {
    const h = harness({
      getState: limitReached,
      listWaiting: () => Promise.reject(new Error("queue down")),
    });
    await runSample(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not resolve the notice when the state could not be read", async () => {
    const h = harness({
      getState: () => Promise.reject(new Error("state down")),
    });
    await runSample(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("keeps the count when the notice could not be resolved", async () => {
    const h = harness({
      getState: limitReached,
      resolveNotice: () => Promise.reject(new Error("db down")),
    });
    await runSample(h.deps);
    expect(h.states).toEqual([]);
  });

  test("does not throw when the notice could not be resolved", async () => {
    const h = harness({
      getState: limitReached,
      resolveNotice: () => Promise.reject(new Error("db down")),
    });
    await expect(runSample(h.deps)).resolves.toBeDefined();
  });
});

describe("deadlineCaller", () => {
  test("runs the work while the deadline is far", async () => {
    const call = deadlineCaller(20_000, () => 0, 5_000);
    expect(await call("work", () => Promise.resolve("done"))).toBe("done");
  });

  test("skips the work once the deadline has passed", async () => {
    let started = false;
    const call = deadlineCaller(20_000, () => 20_000, 5_000);
    await call("work", () => {
      started = true;
      return Promise.resolve(1);
    }).catch(() => undefined);
    expect(started).toBe(false);
  });

  test("rejects a call made after the deadline", async () => {
    const call = deadlineCaller(20_000, () => 21_000, 5_000);
    await expect(call("work", () => Promise.resolve(1))).rejects.toThrow(
      "deadline",
    );
  });

  test("cuts a call short at the time left before the deadline", async () => {
    const call = deadlineCaller(20_000, () => 19_990, 5_000);
    await expect(
      call("work", () => new Promise<never>(() => undefined)),
    ).rejects.toBeInstanceOf(CallTimeoutError);
  });

  test("keeps the deadline below the job timeout", async () => {
    const yaml = await Bun.file(
      new URL(
        "../../f/factory/sample_worker_load.script.yaml",
        import.meta.url,
      ),
    ).text();
    const seconds = Number(/^timeout: (\d+)$/m.exec(yaml)?.[1]);
    expect(SAMPLE_DEADLINE_MS).toBeLessThan(seconds * 1000);
  });
});
