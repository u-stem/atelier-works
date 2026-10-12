import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  type CgroupTexts,
  combineUnknownTags,
  findJobById,
  nextFailureCount,
  parseCgroupMemory,
  parseFailureCount,
  RUNNING_BY_SCRIPT_LIMIT,
  remainingCallMs,
  runningQueueQuery,
  summarizeRunning,
  summarizeWaiting,
  summarizeWorkerLoad,
  timingOf,
  WORKER_SAMPLE_FAILED_NOTICE,
  WORKER_SAMPLE_FAILURE_LIMIT,
  WORKER_SAMPLE_QUEUE_PER_PAGE,
  WORKER_SAMPLES_PER_DAY,
  type WorkerLoadSummary,
  waitingQueueQuery,
} from "../../f/factory/lib/worker_load_support.ts";

const NOW = Date.parse("2026-10-12T03:10:30.000Z");

/** nativeのworkerが受けるtag。defaultのworkerの枠を使わない。 */
const NATIVE_WORKER_TAGS = [
  "nativets",
  "bunnative",
  "postgresql",
  "mysql",
  "mssql",
  "graphql",
  "snowflake",
  "bigquery",
  "oracledb",
];

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

  for (const tag of NATIVE_WORKER_TAGS) {
    test(`does not count a job with the native tag ${tag}`, () => {
      expect(summarizeRunning([running({ tag })], null)?.count).toBe(0);
    });
  }

  test("does not count a job with a tag no default worker listens to", () => {
    expect(summarizeRunning([running({ tag: "custom" })], null)?.count).toBe(0);
  });

  test("counts a job with another tag the default worker listens to", () => {
    expect(summarizeRunning([running({ tag: "python3" })], null)?.count).toBe(
      1,
    );
  });

  test("reports the tag of a job no worker is known to listen to", () => {
    expect(
      summarizeRunning([running({ tag: "custom" })], null)?.unknownTags,
    ).toEqual({ jobs: 1, tags: ["custom"] });
  });

  test("reports each unknown tag once, in order", () => {
    expect(
      summarizeRunning(
        [
          running({ tag: "zeta" }),
          running({ tag: "alpha" }),
          running({ tag: "zeta" }),
        ],
        null,
      )?.unknownTags,
    ).toEqual({ jobs: 3, tags: ["alpha", "zeta"] });
  });

  test("does not report the console tag as unknown", () => {
    expect(
      summarizeRunning([running({ tag: "console" })], null)?.unknownTags.jobs,
    ).toBe(0);
  });

  for (const tag of NATIVE_WORKER_TAGS) {
    test(`does not report the native tag ${tag} as unknown`, () => {
      expect(summarizeRunning([running({ tag })], null)?.unknownTags.jobs).toBe(
        0,
      );
    });
  }

  test("does not report a tag the default worker listens to as unknown", () => {
    expect(summarizeRunning([running()], null)?.unknownTags.jobs).toBe(0);
  });

  test("does not report the sampling job itself as unknown", () => {
    expect(
      summarizeRunning([running({ id: "me", tag: "custom" })], "me")
        ?.unknownTags.jobs,
    ).toBe(0);
  });

  test("shortens a very long unknown tag", () => {
    expect(
      summarizeRunning([running({ tag: "x".repeat(500) })], null)?.unknownTags
        .tags[0],
    ).toHaveLength(60);
  });

  test("counts a preview job with the bun tag", () => {
    expect(
      summarizeRunning([running({ job_kind: "preview" })], null)?.count,
    ).toBe(1);
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
    expect(
      summarizeRunning([running(), running({ tag: 7 })], null)?.count,
    ).toBe(1);
  });

  test("skips an element that is not an object", () => {
    expect(summarizeRunning(["x", null, running()], null)?.count).toBe(1);
  });

  test("returns null when the response is not an array", () => {
    expect(summarizeRunning({ error: "x" }, null)).toBeNull();
  });

  test("counts an element that is not an object as malformed", () => {
    expect(summarizeRunning(["x", null, running()], null)?.malformed).toBe(2);
  });

  test("counts an element without a readable tag as malformed", () => {
    expect(
      summarizeRunning([running(), running({ tag: 7 })], null)?.malformed,
    ).toBe(1);
  });

  test("counts an element without a readable job kind as malformed", () => {
    expect(
      summarizeRunning([running(), running({ job_kind: undefined })], null)
        ?.malformed,
    ).toBe(1);
  });

  test("does not count an element without a job kind as running", () => {
    expect(
      summarizeRunning([running(), running({ job_kind: undefined })], null)
        ?.count,
    ).toBe(1);
  });

  test("returns null when every element is malformed", () => {
    expect(summarizeRunning([{ unexpected: true }, "x"], null)).toBeNull();
  });

  test("reports no malformed element for a well-formed list", () => {
    expect(summarizeRunning([running()], null)?.malformed).toBe(0);
  });

  test("reads the sampling job from a short list", () => {
    expect(
      summarizeRunning([running({ id: "me" }), running()], "me")?.selfReadable,
    ).toBe(true);
  });

  test("cannot read the sampling job that a short list lacks", () => {
    expect(summarizeRunning([running()], "me")?.selfReadable).toBe(false);
  });

  test("does not expect the sampling job in a full page", () => {
    const page = Array.from({ length: WORKER_SAMPLE_QUEUE_PER_PAGE }, () =>
      running(),
    );
    expect(summarizeRunning(page, "me")?.selfReadable).toBe(true);
  });

  test("cannot read the sampling job whose tag is unreadable", () => {
    expect(
      summarizeRunning([running({ id: "me", tag: undefined })], "me")
        ?.selfReadable,
    ).toBe(false);
  });

  test("cannot read the sampling job whose job kind is unreadable", () => {
    expect(
      summarizeRunning([running({ id: "me", job_kind: 3 })], "me")
        ?.selfReadable,
    ).toBe(false);
  });

  test("expects no sampling job outside a job", () => {
    expect(summarizeRunning([], null)?.selfReadable).toBe(true);
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

describe("combineUnknownTags", () => {
  test("adds the job counts", () => {
    expect(
      combineUnknownTags({ jobs: 2, tags: ["a"] }, { jobs: 1, tags: ["b"] })
        .jobs,
    ).toBe(3);
  });

  test("merges the tags without duplicates, in order", () => {
    expect(
      combineUnknownTags(
        { jobs: 2, tags: ["b", "c"] },
        { jobs: 1, tags: ["a", "b"] },
      ).tags,
    ).toEqual(["a", "b", "c"]);
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

  for (const tag of NATIVE_WORKER_TAGS) {
    test(`does not count a job with the native tag ${tag}`, () => {
      expect(summarizeWaiting([waiting(900, { tag })], NOW)?.count).toBe(0);
    });
  }

  test("does not count a job with a tag no worker is known to listen to", () => {
    expect(
      summarizeWaiting([waiting(900, { tag: "custom" })], NOW)?.count,
    ).toBe(0);
  });

  test("reports the tag of a waiting job no worker is known to listen to", () => {
    expect(
      summarizeWaiting([waiting(900, { tag: "custom" })], NOW)?.unknownTags,
    ).toEqual({ jobs: 1, tags: ["custom"] });
  });

  test("does not report the console tag of a waiting job as unknown", () => {
    expect(
      summarizeWaiting([waiting(900, { tag: "console" })], NOW)?.unknownTags
        .jobs,
    ).toBe(0);
  });

  test("counts the parent job of a flow that has not started", () => {
    expect(
      summarizeWaiting([waiting(900, { job_kind: "flow", tag: "flow" })], NOW)
        ?.count,
    ).toBe(1);
  });

  test("counts a job scheduled exactly now", () => {
    expect(summarizeWaiting([waiting(0)], NOW)?.count).toBe(1);
  });

  test("reports zero wait for a job scheduled exactly now", () => {
    expect(summarizeWaiting([waiting(0)], NOW)?.maxWaitSeconds).toBe(0);
  });

  test("counts a job whose suspend count is zero", () => {
    expect(summarizeWaiting([waiting(60, { suspend: 0 })], NOW)?.count).toBe(1);
  });

  test("counts an element without a readable tag as malformed", () => {
    expect(
      summarizeWaiting([waiting(60), waiting(60, { tag: null })], NOW)
        ?.malformed,
    ).toBe(1);
  });

  test("counts an element with an unreadable scheduled time as malformed", () => {
    expect(
      summarizeWaiting([waiting(60), waiting(60, { scheduled_for: "x" })], NOW)
        ?.malformed,
    ).toBe(1);
  });

  test("returns null when every element is malformed", () => {
    expect(summarizeWaiting([{ unexpected: true }, "x"], NOW)).toBeNull();
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
      summarizeWaiting(
        [waiting(60), waiting(60, { scheduled_for: "soon" })],
        NOW,
      )?.count,
    ).toBe(1);
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

describe("call budget", () => {
  test("allows the per-call limit while the deadline is far", () => {
    expect(remainingCallMs(20_000, 0, 5_000)).toBe(5_000);
  });

  test("shortens the call to the time left before the deadline", () => {
    expect(remainingCallMs(20_000, 17_000, 5_000)).toBe(3_000);
  });

  test("allows nothing at the deadline", () => {
    expect(remainingCallMs(20_000, 20_000, 5_000)).toBe(0);
  });

  test("allows nothing after the deadline", () => {
    expect(remainingCallMs(20_000, 25_000, 5_000)).toBe(0);
  });
});

describe("constants", () => {
  test("raises a notice kind that is an action notice", () => {
    expect(noticeSeverity(WORKER_SAMPLE_FAILED_NOTICE.kind)).toBe("action");
  });

  test("tells where to look in the notice message", () => {
    expect(WORKER_SAMPLE_FAILED_NOTICE.message).toMatch(
      /次の操作: f\/factory\/sample_worker_loadの直近のジョブログ/,
    );
  });

  test("waits for more than one failure before the notice", () => {
    expect(WORKER_SAMPLE_FAILURE_LIMIT).toBeGreaterThan(1);
  });
});

const MIB = 1024 * 1024;

function loadSummary(
  overrides: Partial<WorkerLoadSummary> = {},
): WorkerLoadSummary {
  return {
    sample_count: 720,
    expected_count: 720,
    lag_max_seconds: 5,
    lag_over_count: 3,
    running_ratio_max: 2 / 3,
    running_ratio_avg: 0.27,
    mem_anon_max_bytes: 80 * MIB,
    mem_anon_max_ratio: 0.02,
    mem_working_set_max_bytes: 260 * MIB,
    mem_oom_increase: 0,
    mem_oom_kill_increase: 0,
    max_wait_max_seconds: 120,
    ...overrides,
  };
}

describe("summarizeWorkerLoad", () => {
  test("shows the sample count against the expected count", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "記録720/720件(欠け0%)",
    );
  });

  test("shows the share of missing samples", () => {
    expect(summarizeWorkerLoad(loadSummary({ sample_count: 540 }))).toContain(
      "記録540/720件(欠け25%)",
    );
  });

  test("does not show a negative share when there are more samples than expected", () => {
    expect(summarizeWorkerLoad(loadSummary({ sample_count: 725 }))).toContain(
      "欠け0%",
    );
  });

  test("shows the largest lag and the count of laggy samples", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "遅れ: 最大5秒、30秒以上3件",
    );
  });

  test("says the lag is unknown when no sample has one", () => {
    expect(
      summarizeWorkerLoad(
        loadSummary({ lag_max_seconds: null, lag_over_count: 0 }),
      ),
    ).toContain("遅れ: 不明");
  });

  test("shows the running share of the other jobs as percentages", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "他のジョブの枠の使用: 最大67%、平均27%",
    );
  });

  test("says the running share is unknown when no sample has one", () => {
    expect(
      summarizeWorkerLoad(
        loadSummary({ running_ratio_max: null, running_ratio_avg: null }),
      ),
    ).toContain("他のジョブの枠の使用: 不明");
  });

  test("shows the anon peak in MiB with its share of the limit", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "メモリ: anon最大80MiB(上限の2%)",
    );
  });

  test("omits the share of the limit when there is no limit", () => {
    expect(
      summarizeWorkerLoad(loadSummary({ mem_anon_max_ratio: null })),
    ).toContain("メモリ: anon最大80MiB、");
  });

  test("shows the working set peak in MiB", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "working set最大260MiB",
    );
  });

  test("says the memory is unknown when no sample has it", () => {
    expect(
      summarizeWorkerLoad(
        loadSummary({
          mem_anon_max_bytes: null,
          mem_anon_max_ratio: null,
          mem_working_set_max_bytes: null,
        }),
      ),
    ).toContain("メモリ: 不明");
  });

  test("says there was no OOM when both counters did not grow", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain("OOMなし");
  });

  test("shows the OOM and kill counts when a counter grew", () => {
    expect(
      summarizeWorkerLoad(
        loadSummary({ mem_oom_increase: 2, mem_oom_kill_increase: 1 }),
      ),
    ).toContain("OOMあり(OOM 2回、kill 1回)");
  });

  test("says the OOM is unknown when a counter could not be read", () => {
    expect(
      summarizeWorkerLoad(loadSummary({ mem_oom_increase: null })),
    ).toContain("OOMの増分は不明");
  });

  test("shows the longest wait as a lower bound", () => {
    expect(summarizeWorkerLoad(loadSummary())).toContain(
      "待ちの最長: 120秒以上",
    );
  });

  test("says the wait is unknown when no sample has one", () => {
    expect(
      summarizeWorkerLoad(loadSummary({ max_wait_max_seconds: null })),
    ).toContain("待ちの最長: 不明");
  });

  test("expects one sample every two minutes", () => {
    expect(WORKER_SAMPLES_PER_DAY).toBe(720);
  });
});
