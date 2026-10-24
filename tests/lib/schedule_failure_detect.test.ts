import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import { describe, expect, test } from "bun:test";
import type { JobIds } from "../../f/factory/lib/job_ids.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  type PreviousScheduleFailure,
  SCHEDULE_FAILING_CHECK_FAILED_NOTICE,
} from "../../f/factory/lib/schedule_failing.ts";
import {
  detectScheduleFailures,
  type ScheduleFailureDetectDeps,
} from "../../f/factory/lib/schedule_failure_detect.ts";
import {
  SCAN_LOOKBACK_MS,
  SCAN_MAX_WINDOW_MS,
  SCAN_OVERLAP_MS,
  SCAN_PAGE_SIZE,
  SCHEDULE_DETECTOR_PATH,
} from "../../f/factory/lib/schedule_failure_scan.ts";
import type { FailureRecord, NoticeRecord } from "../../f/factory/lib/types.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const BASELINE = NOW - 30 * MIN;
const POLL = "f/factory/poll_prs";
const OTHER = "f/factory/watch_pr_ci";

const iso = (ms: number): string => new Date(ms).toISOString();

/** 失敗した実行の一覧の1件。IDは決まった形で、`n`ごとに異なる。 */
function failedJob(
  n: number,
  completedAtMs: number,
  scriptPath: string = POLL,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `0198a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
    success: false,
    script_path: scriptPath,
    schedule_path: scriptPath,
    completed_at: iso(completedAtMs),
    started_at: iso(completedAtMs - MIN),
    canceled: false,
    is_skipped: false,
    ...extra,
  };
}

function jobIdOf(n: number): string {
  return `0198a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
}

type World = {
  /** 検出器の直近の成功した実行。`null`なら初回。 */
  baselineRun: Record<string, unknown> | null;
  baselineResult: unknown;
  /** 失敗の一覧のページ。 */
  failurePages: unknown[][];
  /** scriptごとの履歴(新しい順)。 */
  history: Record<string, unknown>;
  /** 15分以内に見えるジョブ。 */
  recentVisible: unknown[];
  /** 24時間以内に見えるジョブ。 */
  wideVisible: unknown[];
  recorded: Set<string>;
  previous: Record<string, PreviousScheduleFailure | null>;
  jobDetails: Record<string, unknown>;
  recordError: Error | null;
  getJobError: boolean;
  listFailuresError: Error | null;
  baselineResultError: Error | null;
  previousError: boolean;
  historyError: boolean;
  noticeError: boolean;
};

function newWorld(): World {
  return {
    baselineRun: {
      id: "baseline-run",
      success: true,
      schedule_path: SCHEDULE_DETECTOR_PATH,
      started_at: iso(NOW - 5 * MIN),
    },
    baselineResult: { processed_until: iso(BASELINE) },
    failurePages: [[]],
    history: {},
    recentVisible: [{ script_path: POLL, schedule_path: POLL }],
    wideVisible: [{ script_path: POLL, schedule_path: POLL }],
    recorded: new Set(),
    previous: {},
    jobDetails: {},
    recordError: null,
    getJobError: false,
    listFailuresError: null,
    baselineResultError: null,
    previousError: false,
    historyError: false,
    noticeError: false,
  };
}

type Harness = {
  readonly deps: ScheduleFailureDetectDeps;
  readonly queries: ListCompletedJobsData[];
  readonly records: { record: FailureRecord; jobIds: JobIds }[];
  readonly notices: NoticeRecord[];
  readonly sent: { flowPath: string; jobId: string; error: string }[];
  readonly events: string[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly getJobIds: string[];
};

function harness(world: World): Harness {
  const queries: ListCompletedJobsData[] = [];
  const records: { record: FailureRecord; jobIds: JobIds }[] = [];
  const notices: NoticeRecord[] = [];
  const sent: { flowPath: string; jobId: string; error: string }[] = [];
  const events: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const getJobIds: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };
  const deps: ScheduleFailureDetectDeps = {
    workspace: "factory",
    now: () => NOW,
    listCompletedJobs: async (query) => {
      queries.push(query);
      if (query.schedulePath === SCHEDULE_DETECTOR_PATH) {
        return world.baselineRun === null ? [] : [world.baselineRun];
      }
      if (query.success === false) {
        if (world.listFailuresError !== null) throw world.listFailuresError;
        return world.failurePages[(query.page ?? 1) - 1] ?? [];
      }
      if (query.scriptPathExact !== undefined) {
        if (world.historyError) throw new Error("history down");
        return world.history[query.scriptPathExact] ?? [];
      }
      const since = Date.parse(query.startedAfter ?? "");
      return NOW - since <= 15 * MIN ? world.recentVisible : world.wideVisible;
    },
    getCompletedJobResult: async () => {
      if (world.baselineResultError !== null) throw world.baselineResultError;
      return world.baselineResult;
    },
    getJob: async (id) => {
      getJobIds.push(id);
      if (world.getJobError) throw new Error("job api down");
      return (
        world.jobDetails[id] ?? { result: { error: { message: `err-${id}` } } }
      );
    },
    listRecordedJobIds: async (ids) => {
      events.push("listRecorded");
      return new Set(ids.filter((id) => world.recorded.has(id)));
    },
    getLatestFailure: async (flowPath) => {
      events.push(`previous:${flowPath}`);
      if (world.previousError) throw new Error("db down");
      return world.previous[flowPath] ?? null;
    },
    recordFailure: async (record, jobIds) => {
      events.push(`record:${record.job_id}`);
      if (world.recordError !== null) throw world.recordError;
      records.push({ record, jobIds });
      return records.length;
    },
    addNotice: async (record) => {
      events.push(`notice:${record.kind}`);
      if (world.noticeError) throw new Error("notice down");
      notices.push(record);
      return notices.length;
    },
    sendJobFailed: async (failure) => {
      events.push(`send:${failure.jobId}`);
      sent.push(failure);
    },
    log,
  };
  return {
    deps,
    queries,
    records,
    notices,
    sent,
    events,
    warnings,
    errors,
    getJobIds,
  };
}

describe("detectScheduleFailures: the first run", () => {
  function firstRun(): World {
    const world = newWorld();
    world.baselineRun = null;
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    return world;
  }

  test("reports that it only made the baseline", async () => {
    const result = await detectScheduleFailures(harness(firstRun()).deps);
    expect(result.mode).toBe("bootstrap");
  });

  test("starts the next scan from the start of this run", async () => {
    const result = await detectScheduleFailures(harness(firstRun()).deps);
    expect(result.processed_until).toBe(iso(NOW));
  });

  test("records no past failure", async () => {
    const h = harness(firstRun());
    await detectScheduleFailures(h.deps);
    expect(h.records).toEqual([]);
  });

  test("does not list failures", async () => {
    const h = harness(firstRun());
    await detectScheduleFailures(h.deps);
    expect(h.queries.some((query) => query.success === false)).toBe(false);
  });

  test("still checks that other jobs are visible", async () => {
    const world = firstRun();
    world.recentVisible = [];
    world.wideVisible = [];
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "visible",
    );
  });
});

describe("detectScheduleFailures: the window", () => {
  test("reads the result of the baseline run", async () => {
    const world = newWorld();
    const ids: string[] = [];
    const h = harness(world);
    const deps: ScheduleFailureDetectDeps = {
      ...h.deps,
      getCompletedJobResult: async (id) => {
        ids.push(id);
        return world.baselineResult;
      },
    };
    await detectScheduleFailures(deps);
    expect(ids).toEqual(["baseline-run"]);
  });

  test("lists the failures started after the lookback before the baseline", async () => {
    const h = harness(newWorld());
    await detectScheduleFailures(h.deps);
    const query = h.queries.find((q) => q.success === false);
    expect(query?.startedAfter).toBe(iso(BASELINE - SCAN_LOOKBACK_MS));
  });

  test("starts a day back when the baseline is older than a day", async () => {
    const world = newWorld();
    world.baselineResult = { processed_until: iso(NOW - 30 * HOUR) };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    const query = h.queries.find((q) => q.success === false);
    expect(query?.startedAfter).toBe(
      iso(NOW - SCAN_MAX_WINDOW_MS - SCAN_LOOKBACK_MS),
    );
  });

  test("warns when the baseline is older than a day", async () => {
    const world = newWorld();
    world.baselineResult = { processed_until: iso(NOW - 30 * HOUR) };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.warnings).toContain(
      "the last scan is older than the maximum window; scanning the last day only",
    );
  });

  test("uses the start of the baseline run when the result has no processed_until", async () => {
    const world = newWorld();
    world.baselineResult = { found: 0 };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    const query = h.queries.find((q) => q.success === false);
    expect(query?.startedAfter).toBe(iso(NOW - 5 * MIN - SCAN_LOOKBACK_MS));
  });

  test("fails when the result of the baseline run cannot be read", async () => {
    const world = newWorld();
    world.baselineResultError = new Error("result api down");
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "result api down",
    );
  });

  test("fails when the failures cannot be listed", async () => {
    const world = newWorld();
    world.listFailuresError = new Error("list api down");
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "list api down",
    );
  });
});

describe("detectScheduleFailures: the visibility check", () => {
  test("fails when no job is visible in a day", async () => {
    const world = newWorld();
    world.recentVisible = [];
    world.wideVisible = [];
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "no job of another schedule is visible",
    );
  });

  test("only warns when jobs are visible in a day but not in 15 minutes", async () => {
    const world = newWorld();
    world.recentVisible = [];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.warnings).toContain(
      "no job of another schedule started in the last 15 minutes",
    );
  });

  test("does not read a day when jobs are visible in 15 minutes", async () => {
    const h = harness(newWorld());
    await detectScheduleFailures(h.deps);
    const visibility = h.queries.filter(
      (q) =>
        q.success === undefined &&
        q.schedulePath === undefined &&
        q.scriptPathExact === undefined,
    );
    expect(visibility).toHaveLength(1);
  });

  test("ignores the runs of the detector itself", async () => {
    const world = newWorld();
    world.recentVisible = [
      {
        script_path: SCHEDULE_DETECTOR_PATH,
        schedule_path: SCHEDULE_DETECTOR_PATH,
      },
    ];
    world.wideVisible = [];
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "visible",
    );
  });
});

describe("detectScheduleFailures: recording", () => {
  function twoFailures(): World {
    const world = newWorld();
    world.failurePages = [
      [failedJob(2, NOW - 10 * MIN), failedJob(1, NOW - 20 * MIN)],
    ];
    return world;
  }

  test("records the failures oldest first", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records.map((r) => r.record.job_id)).toEqual([
      jobIdOf(1),
      jobIdOf(2),
    ]);
  });

  test("records the time the job completed", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.record.occurred_at).toBe(iso(NOW - 20 * MIN));
  });

  test("records the failure under the script path", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.record.flow_path).toBe(POLL);
  });

  test("records a failure that has no step", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.record.step).toBeNull();
  });

  test("records the error read from the job", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.record.error).toBe(`err-${jobIdOf(1)}`);
  });

  test("links the record to the failed job", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.jobIds).toEqual({
      job_id: jobIdOf(1),
      root_job_id: jobIdOf(1),
    });
  });

  test("skips a job that is already recorded", async () => {
    const world = twoFailures();
    world.recorded.add(jobIdOf(1));
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.records.map((r) => r.record.job_id)).toEqual([jobIdOf(2)]);
  });

  test("does not read the error of a job that is already recorded", async () => {
    const world = twoFailures();
    world.recorded.add(jobIdOf(1));
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.getJobIds).toEqual([jobIdOf(2)]);
  });

  test("checks the records once for all failures", async () => {
    const h = harness(twoFailures());
    await detectScheduleFailures(h.deps);
    expect(h.events.filter((e) => e === "listRecorded")).toHaveLength(1);
  });

  test("records a failure with a fallback error when the job cannot be read", async () => {
    const world = twoFailures();
    world.getJobError = true;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.records[0]?.record.error).toBe(
      "the job failed without a readable error",
    );
  });

  test("warns when the error of a job cannot be read", async () => {
    const world = twoFailures();
    world.getJobError = true;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.warnings).toContain("could not read the error of a failed job");
  });

  test("warns about an element it cannot read", async () => {
    const world = newWorld();
    world.failurePages = [[null, failedJob(1, NOW - 10 * MIN)]];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.warnings).toContain(
      "the failure list has elements that could not be read",
    );
  });

  test("counts the failures it found and recorded", async () => {
    const world = twoFailures();
    world.recorded.add(jobIdOf(1));
    const result = await detectScheduleFailures(harness(world).deps);
    expect({ found: result.found, recorded: result.recorded }).toEqual({
      found: 2,
      recorded: 1,
    });
  });

  test("records nothing when no failure is new", async () => {
    const h = harness(newWorld());
    await detectScheduleFailures(h.deps);
    expect(h.records).toEqual([]);
  });

  test("continues with the other failures when one cannot be recorded", async () => {
    const world = twoFailures();
    const h = harness(world);
    let first = true;
    const deps: ScheduleFailureDetectDeps = {
      ...h.deps,
      recordFailure: async (record, jobIds) => {
        if (first) {
          first = false;
          throw new Error("db down");
        }
        return await h.deps.recordFailure(record, jobIds);
      },
    };
    await detectScheduleFailures(deps).catch(() => undefined);
    expect(h.records.map((r) => r.record.job_id)).toEqual([jobIdOf(2)]);
  });

  test("fails at the end when a failure cannot be recorded", async () => {
    const world = twoFailures();
    world.recordError = new Error("db down");
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "failed to record 2 schedule failure(s)",
    );
  });
});

describe("detectScheduleFailures: the point to continue from", () => {
  test("is a minute before the start of the run", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN), failedJob(2, NOW - 10 * MIN)],
    ];
    const result = await detectScheduleFailures(harness(world).deps);
    expect(result.processed_until).toBe(iso(NOW - SCAN_OVERLAP_MS));
  });

  test("moves on when the only failure was already recorded", async () => {
    const world = newWorld();
    world.baselineResult = { processed_until: iso(NOW - 10 * MIN) };
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.recorded.add(jobIdOf(1));
    const result = await detectScheduleFailures(harness(world).deps);
    expect(result.processed_until).toBe(iso(NOW - SCAN_OVERLAP_MS));
  });

  test("is a minute before the start of the run when there is no failure", async () => {
    const result = await detectScheduleFailures(harness(newWorld()).deps);
    expect(result.processed_until).toBe(iso(NOW - SCAN_OVERLAP_MS));
  });

  test("reports the scan mode", async () => {
    const result = await detectScheduleFailures(harness(newWorld()).deps);
    expect(result.mode).toBe("scan");
  });
});

describe("detectScheduleFailures: more failures than the pages hold", () => {
  const fullPage = (from: number): unknown[] =>
    Array.from({ length: SCAN_PAGE_SIZE }, (_, i) =>
      failedJob(from + i, BASELINE + (from + i) * 1000),
    );

  function saturated(): World {
    const world = newWorld();
    world.failurePages = [0, 1, 2, 3, 4].map((p) => fullPage(1 + p * 1000));
    return world;
  }

  test("reads five pages", async () => {
    const h = harness(saturated());
    await detectScheduleFailures(h.deps);
    expect(h.queries.filter((q) => q.success === false)).toHaveLength(5);
  });

  test("reports that it stopped at the limit", async () => {
    const result = await detectScheduleFailures(harness(saturated()).deps);
    expect(result.truncated).toBe(true);
  });

  test("continues from the last failure it processed", async () => {
    const world = saturated();
    const result = await detectScheduleFailures(harness(world).deps);
    expect(result.processed_until).toBe(iso(BASELINE + 4100 * 1000));
  });

  test("fails when the pages hold nothing newer than the baseline", async () => {
    const world = newWorld();
    world.failurePages = [0, 1, 2, 3, 4].map((p) =>
      Array.from({ length: SCAN_PAGE_SIZE }, (_, i) =>
        failedJob(p * 1000 + i, BASELINE - 1000 - i),
      ),
    );
    await expect(detectScheduleFailures(harness(world).deps)).rejects.toThrow(
      "no progress",
    );
  });
});

describe("detectScheduleFailures: the notification", () => {
  test("sends job_failed for the first failure of a script", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.history[POLL] = [
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toEqual([
      { flowPath: POLL, jobId: jobIdOf(1), error: `err-${jobIdOf(1)}` },
    ]);
  });

  test("sends once when two failures of the same error come in one window", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN), failedJob(2, NOW - 10 * MIN)],
    ];
    world.history[POLL] = [
      { id: jobIdOf(2), success: false },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.jobDetails = {
      [jobIdOf(1)]: { result: { error: { message: "same" } } },
      [jobIdOf(2)]: { result: { error: { message: "same" } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toHaveLength(1);
  });

  test("puts the newest failure in the message", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN), failedJob(2, NOW - 10 * MIN)],
    ];
    world.history[POLL] = [
      { id: jobIdOf(2), success: false },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.jobDetails = {
      [jobIdOf(1)]: { result: { error: { message: "same" } } },
      [jobIdOf(2)]: { result: { error: { message: "same" } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent[0]?.jobId).toBe(jobIdOf(2));
  });

  test("sends once when the error changes in the middle of the window", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN), failedJob(2, NOW - 10 * MIN)],
    ];
    world.history[POLL] = [
      { id: jobIdOf(2), success: false },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.jobDetails = {
      [jobIdOf(1)]: { result: { error: { message: "first" } } },
      [jobIdOf(2)]: { result: { error: { message: "second" } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent.map((s) => s.error)).toEqual(["second"]);
  });

  test("sends when a success came between two failures", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 30 * MIN), failedJob(3, NOW - 10 * MIN)],
    ];
    world.history[POLL] = [
      { id: jobIdOf(3), success: false },
      { id: jobIdOf(2), success: true },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.previous[POLL] = { job_id: jobIdOf(1), error: `err-${jobIdOf(1)}` };
    world.jobDetails = {
      [jobIdOf(1)]: { result: { error: { message: "same" } } },
      [jobIdOf(3)]: { result: { error: { message: "same" } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent.map((s) => s.jobId)).toEqual([jobIdOf(3)]);
  });

  test("stays quiet for a failure that repeats the recorded one", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(2, NOW - 10 * MIN)]];
    world.history[POLL] = [
      { id: jobIdOf(2), success: false },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.previous[POLL] = { job_id: jobIdOf(1), error: "same" };
    world.jobDetails = {
      [jobIdOf(2)]: { result: { error: { message: "same" } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toEqual([]);
  });

  test("reads the previous failure of a script before it records any", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.events.indexOf(`previous:${POLL}`)).toBeLessThan(
      h.events.indexOf(`record:${jobIdOf(1)}`),
    );
  });

  test("records a failure before it announces it", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.events.indexOf(`record:${jobIdOf(1)}`)).toBeLessThan(
      h.events.indexOf(`send:${jobIdOf(1)}`),
    );
  });

  test("announces a script that failed for the first time even when the previous failure cannot be read", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.previousError = true;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toHaveLength(1);
  });

  test("announces a failure when the history cannot be read", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.historyError = true;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toHaveLength(1);
  });

  test("does not announce a failure it could not record", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.recordError = new Error("db down");
    const h = harness(world);
    await detectScheduleFailures(h.deps).catch(() => undefined);
    expect(h.sent).toEqual([]);
  });

  test("does not announce a failure that was already recorded", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    world.recorded.add(jobIdOf(1));
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toEqual([]);
  });

  test("keeps going when the announcement fails", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 10 * MIN), failedJob(2, NOW - 9 * MIN, OTHER)],
    ];
    const h = harness(world);
    const deps: ScheduleFailureDetectDeps = {
      ...h.deps,
      sendJobFailed: async () => {
        throw new Error("discord down");
      },
    };
    await detectScheduleFailures(deps);
    expect(h.records).toHaveLength(2);
  });

  test("logs an announcement that fails", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    const h = harness(world);
    const deps: ScheduleFailureDetectDeps = {
      ...h.deps,
      sendJobFailed: async () => {
        throw new Error("discord down");
      },
    };
    await detectScheduleFailures(deps);
    expect(h.errors).toContain("failed to send discord notification");
  });

  test("handles each script on its own", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN, POLL), failedJob(2, NOW - 10 * MIN, OTHER)],
    ];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent.map((s) => s.flowPath)).toEqual([POLL, OTHER]);
  });

  test("reads the history of a script once", async () => {
    const world = newWorld();
    world.failurePages = [
      [failedJob(1, NOW - 20 * MIN), failedJob(2, NOW - 10 * MIN)],
    ];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.queries.filter((q) => q.scriptPathExact === POLL)).toHaveLength(1);
  });

  test("asks for the history of the script without skipped runs", async () => {
    const world = newWorld();
    world.failurePages = [[failedJob(1, NOW - 10 * MIN)]];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.queries.find((q) => q.scriptPathExact === POLL)).toMatchObject({
      isSkipped: false,
      orderDesc: true,
      perPage: 10,
    });
  });
});

describe("detectScheduleFailures: failures that continue", () => {
  function failingScript(): World {
    const world = newWorld();
    world.failurePages = [[failedJob(3, NOW - 10 * MIN)]];
    world.history[POLL] = [
      { id: jobIdOf(3), success: false },
      { id: jobIdOf(2), success: false },
      { id: jobIdOf(1), success: false },
      { id: "ok", success: true },
    ];
    world.previous[POLL] = { job_id: jobIdOf(2), error: `err-${jobIdOf(3)}` };
    return world;
  }

  test("leaves a schedule_failing notice when the last three runs failed", async () => {
    const h = harness(failingScript());
    await detectScheduleFailures(h.deps);
    expect(h.notices.map((n) => n.kind)).toEqual(["schedule_failing"]);
  });

  test("names the script in the notice", async () => {
    const h = harness(failingScript());
    await detectScheduleFailures(h.deps);
    expect(h.notices[0]?.message).toContain(POLL);
  });

  test("announces to Discord when the notice is new and no job_failed went out", async () => {
    const world = failingScript();
    world.jobDetails = {
      [jobIdOf(3)]: { result: { error: { message: `err-${jobIdOf(3)}` } } },
    };
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent.map((s) => s.jobId)).toEqual([jobIdOf(3)]);
  });

  test("does not announce twice for one script in a run", async () => {
    const world = failingScript();
    world.previous[POLL] = null;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.sent).toHaveLength(1);
  });

  test("leaves no notice when the last runs did not all fail", async () => {
    const world = failingScript();
    world.history[POLL] = [
      { id: jobIdOf(3), success: false },
      { id: jobIdOf(2), success: true },
      { id: jobIdOf(1), success: false },
    ];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("flags a script once even when it has several new failures", async () => {
    const world = failingScript();
    world.failurePages = [
      [failedJob(2, NOW - 20 * MIN), failedJob(3, NOW - 10 * MIN)],
    ];
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("flags the script after it recorded the failures", async () => {
    const h = harness(failingScript());
    await detectScheduleFailures(h.deps);
    expect(h.events.indexOf(`record:${jobIdOf(3)}`)).toBeLessThan(
      h.events.indexOf("notice:schedule_failing"),
    );
  });

  test("leaves the check failed notice when the history cannot be read", async () => {
    const world = failingScript();
    world.historyError = true;
    const h = harness(world);
    await detectScheduleFailures(h.deps);
    expect(h.notices).toEqual([SCHEDULE_FAILING_CHECK_FAILED_NOTICE]);
  });
});
