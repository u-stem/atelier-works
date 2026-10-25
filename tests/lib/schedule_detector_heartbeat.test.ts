import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { PERIODIC_JOB_WAIT_SECONDS } from "../../f/factory/lib/periodic_worker.ts";
import {
  checkScheduleDetector,
  SCHEDULE_DETECTOR_DISABLED_NOTICE,
  SCHEDULE_DETECTOR_NOTICE_PREFIX,
  SCHEDULE_DETECTOR_STALE_MS,
  SCHEDULE_DETECTOR_STALLED_NOTICE,
  SCHEDULE_DETECTOR_WATCH_PATH,
  SCHEDULE_DETECTOR_WATCH_RUNS,
  type ScheduleDetectorCheckDeps,
} from "../../f/factory/lib/schedule_detector_heartbeat.ts";
import {
  findBaselineRun,
  SCHEDULE_DETECTOR_PATH,
} from "../../f/factory/lib/schedule_failure_scan.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import { listedCompletedJob } from "../fixtures/windmill_completed_job.ts";

const MIN = 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

type World = {
  /** 検出器の成功した実行の一覧の応答。 */
  successes: unknown;
  successesError: boolean;
  /** `default_worker_watch`の実行の一覧の応答。 */
  watchRuns: unknown;
  watchRunsError: boolean;
  schedule: unknown;
  scheduleError: boolean;
  addNoticeResult: number | null;
  addNoticeError: boolean;
  resolveError: boolean;
  notifyError: boolean;
  hang: boolean;
};

/** 実機の形の、検出器の成功した実行。`completed_at`は無く、完了は開始の1秒後。 */
function lastSuccess(completedAtMs: number) {
  return [
    listedCompletedJob({
      id: "run-1",
      success: true,
      scriptPath: SCHEDULE_DETECTOR_PATH,
      schedulePath: SCHEDULE_DETECTOR_PATH,
      startedAtMs: completedAtMs - 1000,
      durationMs: 1000,
    }),
  ];
}

function watchRun(n: number) {
  return listedCompletedJob({
    id: `watch-${String(n)}`,
    success: true,
    scriptPath: SCHEDULE_DETECTOR_WATCH_PATH,
    schedulePath: SCHEDULE_DETECTOR_WATCH_PATH,
    startedAtMs: NOW - n * MIN - 1000,
    durationMs: 1000,
  });
}

function newWorld(): World {
  return {
    successes: lastSuccess(NOW - 5 * MIN),
    successesError: false,
    watchRuns: [watchRun(1), watchRun(2), watchRun(3), watchRun(4)],
    watchRunsError: false,
    schedule: { enabled: true, edited_at: iso(NOW - 24 * 60 * MIN) },
    scheduleError: false,
    addNoticeResult: 7,
    addNoticeError: false,
    resolveError: false,
    notifyError: false,
    hang: false,
  };
}

type Harness = {
  readonly deps: ScheduleDetectorCheckDeps;
  readonly queries: ListCompletedJobsData[];
  readonly schedulePaths: string[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string }[];
  readonly sent: NotifyEvent[];
  readonly warnings: string[];
};

function harness(world: World, timeoutMs?: number): Harness {
  const queries: ListCompletedJobsData[] = [];
  const schedulePaths: string[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string }[] = [];
  const sent: NotifyEvent[] = [];
  const warnings: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
  const deps: ScheduleDetectorCheckDeps = {
    workspace: "factory",
    now: () => NOW,
    listCompletedJobs: async (query) => {
      queries.push(query);
      if (world.hang) return await new Promise<never>(() => undefined);
      if (query.schedulePath === SCHEDULE_DETECTOR_PATH) {
        if (world.successesError) throw new Error("list down");
        return world.successes;
      }
      if (world.watchRunsError) throw new Error("list down");
      return world.watchRuns;
    },
    getSchedule: async (path) => {
      schedulePaths.push(path);
      if (world.scheduleError) throw new Error("schedule api down");
      return world.schedule;
    },
    addNotice: async (record) => {
      if (world.addNoticeError) throw new Error("db down");
      notices.push(record);
      return world.addNoticeResult;
    },
    resolveNotices: async (kind, prefix) => {
      if (world.resolveError) throw new Error("db down");
      resolved.push({ kind, prefix });
      return 1;
    },
    notify: async (event) => {
      if (world.notifyError) throw new Error("discord down");
      sent.push(event);
    },
    instanceName: "local",
    log,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return { deps, queries, schedulePaths, notices, resolved, sent, warnings };
}

describe("the thresholds", () => {
  test("a detector that has not succeeded for 25 minutes is stale", () => {
    expect(SCHEDULE_DETECTOR_STALE_MS).toBe(25 * MIN);
  });

  test("the threshold is longer than the wait threshold of the periodic worker plus two intervals of the detector", () => {
    // 検出器は5分ごとに動く。待たされて遅れた回と、その次の回が続けて失敗しても、誤って知らせない。
    expect(SCHEDULE_DETECTOR_STALE_MS).toBeGreaterThan(
      PERIODIC_JOB_WAIT_SECONDS * 1000 + 2 * 5 * MIN,
    );
  });

  test("three runs of the watch script must complete before it reports", () => {
    expect(SCHEDULE_DETECTOR_WATCH_RUNS).toBe(3);
  });

  test("the watch script is default_worker_watch", () => {
    expect(SCHEDULE_DETECTOR_WATCH_PATH).toBe("f/factory/default_worker_watch");
  });
});

describe("the notices", () => {
  test("the stalled notice is of the schedule_detector_stale kind", () => {
    expect(SCHEDULE_DETECTOR_STALLED_NOTICE.kind).toBe(
      "schedule_detector_stale",
    );
  });

  test("the disabled notice is of the schedule_detector_stale kind", () => {
    expect(SCHEDULE_DETECTOR_DISABLED_NOTICE.kind).toBe(
      "schedule_detector_stale",
    );
  });

  test("the stalled notice starts with the prefix used to resolve it", () => {
    expect(
      SCHEDULE_DETECTOR_STALLED_NOTICE.message.startsWith(
        SCHEDULE_DETECTOR_NOTICE_PREFIX,
      ),
    ).toBe(true);
  });

  test("the disabled notice starts with the prefix used to resolve it", () => {
    expect(
      SCHEDULE_DETECTOR_DISABLED_NOTICE.message.startsWith(
        SCHEDULE_DETECTOR_NOTICE_PREFIX,
      ),
    ).toBe(true);
  });

  test("the two causes read differently", () => {
    expect(SCHEDULE_DETECTOR_DISABLED_NOTICE.message).not.toBe(
      SCHEDULE_DETECTOR_STALLED_NOTICE.message,
    );
  });

  test("the prefix does not contain the threshold, so that a change of it still resolves an old notice", () => {
    expect(SCHEDULE_DETECTOR_NOTICE_PREFIX).not.toMatch(/\d/);
  });

  test("the stalled notice says what to do next", () => {
    expect(SCHEDULE_DETECTOR_STALLED_NOTICE.message).toContain("次の操作");
  });
});

describe("findBaselineRun completion time", () => {
  test("reads the completion time of the run", () => {
    expect(findBaselineRun(lastSuccess(NOW))?.completedAtMs).toBe(NOW);
  });

  test("leaves the completion time empty when the run has no duration", () => {
    const run = lastSuccess(NOW).map(({ duration_ms: _omit, ...rest }) => rest);
    expect(findBaselineRun(run)?.completedAtMs).toBeNull();
  });
});

describe("checkScheduleDetector: the detector succeeded recently", () => {
  test("is ok", async () => {
    expect(await checkScheduleDetector(harness(newWorld()).deps)).toBe("ok");
  });

  test("resolves the notice of the detector by the prefix", async () => {
    const h = harness(newWorld());
    await checkScheduleDetector(h.deps);
    expect(h.resolved).toEqual([
      {
        kind: "schedule_detector_stale",
        prefix: SCHEDULE_DETECTOR_NOTICE_PREFIX,
      },
    ]);
  });

  test("leaves no notice", async () => {
    const h = harness(newWorld());
    await checkScheduleDetector(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not read the watch runs or the schedule", async () => {
    const h = harness(newWorld());
    await checkScheduleDetector(h.deps);
    expect([h.queries.length, h.schedulePaths.length]).toEqual([1, 0]);
  });

  test("is ok when the last success is exactly at the threshold", async () => {
    const world = newWorld();
    world.successes = lastSuccess(NOW - SCHEDULE_DETECTOR_STALE_MS);
    expect(await checkScheduleDetector(harness(world).deps)).toBe("ok");
  });

  test("asks for the successful runs of the detector schedule", async () => {
    const h = harness(newWorld());
    await checkScheduleDetector(h.deps);
    expect(h.queries[0]).toMatchObject({
      workspace: "factory",
      schedulePath: SCHEDULE_DETECTOR_PATH,
      success: true,
    });
  });

  test("keeps going when the notice cannot be resolved", async () => {
    const world = newWorld();
    world.resolveError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("ok");
  });

  test("warns when the notice cannot be resolved", async () => {
    const world = newWorld();
    world.resolveError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain(
      "could not resolve the schedule detector problem",
    );
  });
});

describe("checkScheduleDetector: the detector has not succeeded for long", () => {
  function old(): World {
    const world = newWorld();
    world.successes = lastSuccess(NOW - SCHEDULE_DETECTOR_STALE_MS - 1);
    return world;
  }

  test("is stalled when the watch script ran three times since", async () => {
    expect(await checkScheduleDetector(harness(old()).deps)).toBe("stalled");
  });

  test("leaves the stalled notice", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.notices).toEqual([SCHEDULE_DETECTOR_STALLED_NOTICE]);
  });

  test("sends the event to Discord once for a new notice", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.sent).toHaveLength(1);
  });

  test("puts the cause and the next action in the event", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.sent[0]).toMatchObject({
      kind: "schedule_detector_stale",
      instance_name: "local",
    });
  });

  test("joins the cause and the next action into the notice", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    const event = h.sent[0];
    expect(
      event?.kind === "schedule_detector_stale"
        ? `${event.cause}。次の操作: ${event.next_action}`
        : null,
    ).toBe(SCHEDULE_DETECTOR_STALLED_NOTICE.message);
  });

  test("does not send again while the notice is unresolved", async () => {
    const world = old();
    world.addNoticeResult = null;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.sent).toEqual([]);
  });

  test("does not resolve the notice", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("counts the runs of the watch script that started after the last success", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.queries[1]).toMatchObject({
      workspace: "factory",
      schedulePath: SCHEDULE_DETECTOR_WATCH_PATH,
      startedAfter: iso(NOW - SCHEDULE_DETECTOR_STALE_MS - 1),
    });
  });

  test("is unknown when the watch script ran fewer than three times, as after a sleep", async () => {
    const world = old();
    world.watchRuns = [watchRun(1), watchRun(2)];
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("leaves no notice when the watch script ran fewer than three times", async () => {
    const world = old();
    world.watchRuns = [];
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not count a run of another schedule", async () => {
    const world = old();
    world.watchRuns = [
      watchRun(1),
      watchRun(2),
      { ...watchRun(3), schedule_path: "f/factory/poll_prs" },
    ];
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("is unknown when the response of the watch runs is not a list", async () => {
    const world = old();
    world.watchRuns = { runs: [] };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("is unknown when the watch runs cannot be listed", async () => {
    const world = old();
    world.watchRunsError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("warns when the watch runs cannot be listed", async () => {
    const world = old();
    world.watchRunsError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain(
      "could not count the runs of the watch script",
    );
  });

  test("is disabled when the schedule is disabled", async () => {
    const world = old();
    world.schedule = { enabled: false, edited_at: iso(NOW - 24 * 60 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("disabled");
  });

  test("leaves the disabled notice when the schedule is disabled", async () => {
    const world = old();
    world.schedule = { enabled: false, edited_at: iso(NOW - 24 * 60 * MIN) };
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.notices).toEqual([SCHEDULE_DETECTOR_DISABLED_NOTICE]);
  });

  test("is stalled when the schedule cannot be read", async () => {
    const world = old();
    world.scheduleError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("is stalled when the schedule has no readable enabled flag", async () => {
    const world = old();
    world.schedule = { edited_at: iso(NOW - 24 * 60 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("reads the schedule of the detector", async () => {
    const h = harness(old());
    await checkScheduleDetector(h.deps);
    expect(h.schedulePaths).toEqual([SCHEDULE_DETECTOR_PATH]);
  });

  test("keeps going when the notice cannot be left", async () => {
    const world = old();
    world.addNoticeError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("keeps going when Discord cannot be reached", async () => {
    const world = old();
    world.notifyError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("warns when the notice cannot be left", async () => {
    const world = old();
    world.addNoticeError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain(
      "could not record the schedule detector problem",
    );
  });
});

describe("checkScheduleDetector: a skipped run", () => {
  test("is not a success", async () => {
    const world = newWorld();
    world.successes = lastSuccess(NOW - 5 * MIN).map((run) => ({
      ...run,
      is_skipped: true,
    }));
    world.schedule = { enabled: true, edited_at: iso(NOW - 24 * 60 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("asks for runs that were not skipped", async () => {
    const h = harness(newWorld());
    await checkScheduleDetector(h.deps);
    expect(h.queries[0]?.isSkipped).toBe(false);
  });
});

describe("checkScheduleDetector: the detector never succeeded", () => {
  function never(): World {
    const world = newWorld();
    world.successes = [];
    return world;
  }

  test("is unknown right after the schedule was deployed", async () => {
    const world = never();
    world.schedule = { enabled: true, edited_at: iso(NOW - 10 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("leaves no notice right after the schedule was deployed", async () => {
    const world = never();
    world.schedule = { enabled: true, edited_at: iso(NOW - 10 * MIN) };
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("is stalled when the schedule was deployed long ago", async () => {
    const world = never();
    world.schedule = { enabled: true, edited_at: iso(NOW - 30 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("is stalled when the schedule was deployed exactly at the threshold", async () => {
    const world = never();
    world.schedule = {
      enabled: true,
      edited_at: iso(NOW - SCHEDULE_DETECTOR_STALE_MS),
    };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("stalled");
  });

  test("is disabled when the schedule is disabled and was deployed long ago", async () => {
    const world = never();
    world.schedule = { enabled: false, edited_at: iso(NOW - 30 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("disabled");
  });

  test("is unknown when the schedule is disabled but was deployed just now", async () => {
    const world = never();
    world.schedule = { enabled: false, edited_at: iso(NOW - 1 * MIN) };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("is unknown when the schedule cannot be read", async () => {
    const world = never();
    world.scheduleError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("warns when the schedule cannot be read", async () => {
    const world = never();
    world.scheduleError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain("could not read the schedule of the detector");
  });

  test("is unknown when the deployment time cannot be read", async () => {
    const world = never();
    world.schedule = { enabled: true };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("does not count the watch runs", async () => {
    const h = harness(never());
    await checkScheduleDetector(h.deps);
    expect(h.queries).toHaveLength(1);
  });
});

describe("checkScheduleDetector: the history cannot be read", () => {
  test("is unknown when the runs of the detector cannot be listed", async () => {
    const world = newWorld();
    world.successesError = true;
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("warns when the runs of the detector cannot be listed", async () => {
    const world = newWorld();
    world.successesError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain(
      "could not list the runs of the schedule detector",
    );
  });

  test("leaves no notice when the runs of the detector cannot be listed", async () => {
    const world = newWorld();
    world.successesError = true;
    const h = harness(world);
    await checkScheduleDetector(h.deps);
    expect([h.notices, h.resolved]).toEqual([[], []]);
  });

  test("is unknown when the response is not a list", async () => {
    const world = newWorld();
    world.successes = { runs: [] };
    expect(await checkScheduleDetector(harness(world).deps)).toBe("unknown");
  });

  test("is unknown when it does not finish within the time limit", async () => {
    const world = newWorld();
    world.hang = true;
    expect(await checkScheduleDetector(harness(world, 5).deps)).toBe("unknown");
  });

  test("warns when it does not finish within the time limit", async () => {
    const world = newWorld();
    world.hang = true;
    const h = harness(world, 5);
    await checkScheduleDetector(h.deps);
    expect(h.warnings).toContain("schedule detector check timed out");
  });
});
