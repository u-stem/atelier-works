import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  type CgroupTexts,
  DEFAULT_WORKER_SLOTS,
  findJobById,
  nextFailureCount,
  parseCgroupMemory,
  parseFailureCount,
  RUNNING_BY_SCRIPT_LIMIT,
  runningQueueQuery,
  summarizeRunning,
  summarizeWaiting,
  timingOf,
  WORKER_SAMPLE_FAILED_NOTICE,
  WORKER_SAMPLE_FAILURE_LIMIT,
  waitingQueueQuery,
} from "../../f/factory/lib/worker_load_support.ts";

const NOW = Date.parse("2026-10-12T03:10:30.000Z");

/** 実機のdefaultのworkerで読んだ形のcgroupの内容。 */
const MEMORY_STAT = [
  "anon 80125952",
  "file 234504192",
  "inactive_anon 19587072",
  "active_anon 68177920",
  "inactive_file 50282496",
  "active_file 18000000",
].join("\n");

function texts(overrides: Partial<CgroupTexts> = {}): CgroupTexts {
  return {
    current: "323907584\n",
    peak: "1371127808\n",
    max: "4294967296\n",
    stat: `${MEMORY_STAT}\n`,
    events:
      "low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\noom_group_kill 0\nsock_throttled 0\n",
    pressure: null,
    ...overrides,
  };
}

describe("parseCgroupMemory", () => {
  test("reads memory.current", () => {
    expect(parseCgroupMemory(texts()).current).toBe(323907584);
  });

  test("reads memory.peak", () => {
    expect(parseCgroupMemory(texts()).peak).toBe(1371127808);
  });

  test("reads memory.max as the limit", () => {
    expect(parseCgroupMemory(texts()).limit).toBe(4294967296);
  });

  test("treats a memory.max of max as no limit", () => {
    expect(parseCgroupMemory(texts({ max: "max\n" })).limit).toBeNull();
  });

  test("reads anon from memory.stat", () => {
    expect(parseCgroupMemory(texts()).anon).toBe(80125952);
  });

  test("subtracts inactive_file from memory.current for the working set", () => {
    expect(parseCgroupMemory(texts()).workingSet).toBe(323907584 - 50282496);
  });

  test("does not let the working set go below zero", () => {
    expect(
      parseCgroupMemory(
        texts({ current: "100\n", stat: "inactive_file 500\n" }),
      ).workingSet,
    ).toBe(0);
  });

  test("leaves the working set null when inactive_file is missing", () => {
    expect(
      parseCgroupMemory(texts({ stat: "anon 1\n" })).workingSet,
    ).toBeNull();
  });

  test("leaves the working set null when memory.current is unreadable", () => {
    expect(parseCgroupMemory(texts({ current: null })).workingSet).toBeNull();
  });

  test("reads the max counter of memory.events", () => {
    expect(parseCgroupMemory(texts()).eventsMax).toBe(3);
  });

  test("reads the oom counter of memory.events", () => {
    expect(parseCgroupMemory(texts()).oom).toBe(2);
  });

  test("reads the oom_kill counter of memory.events", () => {
    expect(parseCgroupMemory(texts()).oomKill).toBe(1);
  });

  test("does not take oom_group_kill for oom_kill", () => {
    expect(
      parseCgroupMemory(texts({ events: "oom_group_kill 9\n" })).oomKill,
    ).toBeNull();
  });

  test("leaves the pressure null when memory.pressure is unreadable", () => {
    expect(parseCgroupMemory(texts()).pressureTotalUs).toBeNull();
  });

  test("reads the total of the some line of memory.pressure", () => {
    const pressure =
      "some avg10=0.00 avg60=0.00 avg300=0.00 total=12345\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=99\n";
    expect(parseCgroupMemory(texts({ pressure })).pressureTotalUs).toBe(12345);
  });

  test("leaves a non-numeric value null", () => {
    expect(parseCgroupMemory(texts({ current: "abc\n" })).current).toBeNull();
  });

  test("leaves an empty file null", () => {
    expect(parseCgroupMemory(texts({ current: "" })).current).toBeNull();
  });

  test("leaves a negative value null", () => {
    expect(parseCgroupMemory(texts({ peak: "-5\n" })).peak).toBeNull();
  });

  test("leaves a value beyond the safe integer range null", () => {
    expect(
      parseCgroupMemory(texts({ current: "99999999999999999999\n" })).current,
    ).toBeNull();
  });

  test("leaves every value null when nothing was readable", () => {
    expect(
      parseCgroupMemory({
        current: null,
        peak: null,
        max: null,
        stat: null,
        events: null,
        pressure: null,
      }),
    ).toEqual({
      current: null,
      anon: null,
      workingSet: null,
      peak: null,
      limit: null,
      eventsMax: null,
      oom: null,
      oomKill: null,
      pressureTotalUs: null,
    });
  });

  test("keeps the other values when memory.peak is missing", () => {
    expect(parseCgroupMemory(texts({ peak: null })).current).toBe(323907584);
  });
});

function running(extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    running: true,
    job_kind: "script",
    tag: "bun",
    script_path: "f/factory/poll_prs",
    ...extra,
  };
}

function waiting(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    id: "wait-1",
    running: false,
    job_kind: "script",
    tag: "bun",
    scheduled_for: new Date(NOW - seconds * 1000).toISOString(),
    ...extra,
  };
}

describe("summarizeRunning", () => {
  test("counts a running script job", () => {
    expect(summarizeRunning([running()], null)?.count).toBe(1);
  });

  test("does not count the sampling job itself", () => {
    expect(
      summarizeRunning([running({ id: "me" }), running()], "me")?.count,
    ).toBe(1);
  });

  test("does not count the parent job of a flow", () => {
    expect(
      summarizeRunning([running({ job_kind: "flow", tag: "flow" })], null)
        ?.count,
    ).toBe(0);
  });

  test("does not count the parent job of a flow preview", () => {
    expect(
      summarizeRunning([running({ job_kind: "flowpreview" })], null)?.count,
    ).toBe(0);
  });

  test("counts a step of a flow", () => {
    expect(
      summarizeRunning([running({ is_flow_step: true })], null)?.count,
    ).toBe(1);
  });

  test("does not count a job with tag console", () => {
    expect(summarizeRunning([running({ tag: "console" })], null)?.count).toBe(
      0,
    );
  });

  test("does not count a job with a native tag", () => {
    expect(summarizeRunning([running({ tag: "nativets" })], null)?.count).toBe(
      0,
    );
  });

  test("counts a dependency job because it uses a slot", () => {
    expect(
      summarizeRunning([running({ job_kind: "dependencies" })], null)?.count,
    ).toBe(1);
  });

  test("does not count a job that is not running", () => {
    expect(summarizeRunning([running({ running: false })], null)?.count).toBe(
      0,
    );
  });

  test("does not count a job whose tag is unreadable", () => {
    expect(summarizeRunning([running({ tag: 7 })], null)?.count).toBe(0);
  });

  test("skips an element that is not an object", () => {
    expect(summarizeRunning(["x", null, running()], null)?.count).toBe(1);
  });

  test("returns null when the response is not an array", () => {
    expect(summarizeRunning({ error: "x" }, null)).toBeNull();
  });

  test("counts the jobs per script path", () => {
    expect(
      summarizeRunning(
        [
          running({ script_path: "f/factory/a" }),
          running({ script_path: "f/factory/a" }),
          running({ script_path: "f/factory/b" }),
        ],
        null,
      )?.byScript,
    ).toEqual({ "f/factory/a": 2, "f/factory/b": 1 });
  });

  test("groups a job without a script path under unknown", () => {
    expect(
      summarizeRunning([running({ script_path: undefined })], null)?.byScript,
    ).toEqual({ unknown: 1 });
  });

  test("folds the scripts beyond the limit into other", () => {
    const jobs = Array.from({ length: RUNNING_BY_SCRIPT_LIMIT + 2 }, (_, i) =>
      running({ script_path: `f/factory/s${String(i).padStart(2, "0")}` }),
    );
    expect(summarizeRunning(jobs, null)?.byScript.other).toBe(2);
  });

  test("keeps at most the limit plus one key", () => {
    const jobs = Array.from({ length: RUNNING_BY_SCRIPT_LIMIT + 5 }, (_, i) =>
      running({ script_path: `f/factory/s${String(i).padStart(2, "0")}` }),
    );
    expect(
      Object.keys(summarizeRunning(jobs, null)?.byScript ?? {}),
    ).toHaveLength(RUNNING_BY_SCRIPT_LIMIT + 1);
  });

  test("keeps the scripts with the most jobs before folding", () => {
    const jobs = [
      ...Array.from({ length: RUNNING_BY_SCRIPT_LIMIT }, (_, i) =>
        running({ script_path: `f/factory/s${String(i).padStart(2, "0")}` }),
      ),
      running({ script_path: "f/factory/busy" }),
      running({ script_path: "f/factory/busy" }),
    ];
    expect(summarizeRunning(jobs, null)?.byScript["f/factory/busy"]).toBe(2);
  });

  test("truncates a long script path", () => {
    const path = `f/factory/${"x".repeat(300)}`;
    const keys = Object.keys(
      summarizeRunning([running({ script_path: path })], null)?.byScript ?? {},
    );
    expect(keys[0]?.length).toBeLessThanOrEqual(120);
  });
});

describe("summarizeWaiting", () => {
  test("counts a job that has waited past its scheduled time", () => {
    expect(summarizeWaiting([waiting(60)], NOW)?.count).toBe(1);
  });

  test("reports the longest wait in seconds", () => {
    expect(
      summarizeWaiting([waiting(60), waiting(200), waiting(5)], NOW)
        ?.maxWaitSeconds,
    ).toBe(200);
  });

  test("does not count a job scheduled in the future", () => {
    expect(summarizeWaiting([waiting(-30)], NOW)?.count).toBe(0);
  });

  test("reports zero wait when nothing is waiting", () => {
    expect(summarizeWaiting([], NOW)?.maxWaitSeconds).toBe(0);
  });

  test("does not count a job with tag console", () => {
    expect(
      summarizeWaiting([waiting(900, { tag: "console" })], NOW)?.count,
    ).toBe(0);
  });

  test("does not count a job with a native tag", () => {
    expect(
      summarizeWaiting([waiting(900, { tag: "nativets" })], NOW)?.count,
    ).toBe(0);
  });

  test("does not count the parent job of a flow", () => {
    expect(
      summarizeWaiting([waiting(900, { job_kind: "flow" })], NOW)?.count,
    ).toBe(0);
  });

  test("does not count a job that is already running", () => {
    expect(summarizeWaiting([waiting(60, { running: true })], NOW)?.count).toBe(
      0,
    );
  });

  test("does not count a suspended job", () => {
    expect(summarizeWaiting([waiting(60, { suspend: 1 })], NOW)?.count).toBe(0);
  });

  test("does not count a job whose scheduled time is unreadable", () => {
    expect(
      summarizeWaiting([waiting(60, { scheduled_for: "soon" })], NOW)?.count,
    ).toBe(0);
  });

  test("returns null when the response is not an array", () => {
    expect(summarizeWaiting("Internal error", NOW)).toBeNull();
  });
});

describe("findJobById", () => {
  test("finds the job with the id", () => {
    expect(
      findJobById([running({ id: "a" }), running({ id: "b" })], "b"),
    ).toEqual(running({ id: "b" }));
  });

  test("returns null when no job has the id", () => {
    expect(findJobById([running({ id: "a" })], "z")).toBeNull();
  });

  test("returns null when the response is not an array", () => {
    expect(findJobById(undefined, "a")).toBeNull();
  });

  test("returns null without an id", () => {
    expect(findJobById([running()], null)).toBeNull();
  });
});

describe("timingOf", () => {
  const job = {
    scheduled_for: "2026-10-12T03:08:30.000Z",
    started_at: "2026-10-12T03:08:33.400Z",
  };

  test("reads the scheduled time", () => {
    expect(timingOf(job).scheduledFor?.toISOString()).toBe(
      "2026-10-12T03:08:30.000Z",
    );
  });

  test("rounds the delay to whole seconds", () => {
    expect(timingOf(job).lagSeconds).toBe(3);
  });

  test("does not report a negative delay", () => {
    expect(
      timingOf({
        scheduled_for: "2026-10-12T03:08:30.000Z",
        started_at: "2026-10-12T03:08:29.000Z",
      }).lagSeconds,
    ).toBe(0);
  });

  test("leaves the delay null without a start time", () => {
    expect(
      timingOf({ scheduled_for: "2026-10-12T03:08:30.000Z" }).lagSeconds,
    ).toBeNull();
  });

  test("keeps the scheduled time when the start time is missing", () => {
    expect(
      timingOf({ scheduled_for: "2026-10-12T03:08:30.000Z" }).scheduledFor,
    ).not.toBeNull();
  });

  test("leaves both null for a value that is not an object", () => {
    expect(timingOf(null)).toEqual({ scheduledFor: null, lagSeconds: null });
  });

  test("leaves the delay null for an unreadable time", () => {
    expect(
      timingOf({ scheduled_for: "x", started_at: "2026-10-12T03:08:33Z" })
        .lagSeconds,
    ).toBeNull();
  });
});

describe("queue queries", () => {
  test("asks for running jobs only", () => {
    expect(runningQueueQuery("factory").running).toBe(true);
  });

  test("asks for the waiting jobs whose scheduled time has passed", () => {
    expect(waitingQueueQuery("factory")).toMatchObject({
      running: false,
      scheduledForBeforeNow: true,
    });
  });

  test("asks for the oldest waiting jobs first", () => {
    expect(waitingQueueQuery("factory").orderDesc).toBe(false);
  });
});

describe("failure count", () => {
  test("reads the saved count", () => {
    expect(parseFailureCount({ worker_sample_failure_count: 3 })).toBe(3);
  });

  test("reads zero from an empty state", () => {
    expect(parseFailureCount(null)).toBe(0);
  });

  test("reads zero from a count that is not a non-negative integer", () => {
    expect(parseFailureCount({ worker_sample_failure_count: -1 })).toBe(0);
  });

  test("adds one after an incomplete run", () => {
    expect(nextFailureCount(2, false)).toBe(3);
  });

  test("resets after a complete run", () => {
    expect(nextFailureCount(4, true)).toBe(0);
  });
});

describe("constants", () => {
  test("sets the slots to the default worker's NUM_WORKERS", () => {
    expect(DEFAULT_WORKER_SLOTS).toBe(3);
  });

  test("raises a notice kind that is an action notice", () => {
    expect(noticeSeverity(WORKER_SAMPLE_FAILED_NOTICE.kind)).toBe("action");
  });

  test("keeps the notice message fixed", () => {
    expect(WORKER_SAMPLE_FAILED_NOTICE.message).toContain("次の操作");
  });

  test("waits for more than one failure before the notice", () => {
    expect(WORKER_SAMPLE_FAILURE_LIMIT).toBeGreaterThan(1);
  });
});
