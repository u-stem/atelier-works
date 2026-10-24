import { describe, expect, test } from "bun:test";
import {
  baselineRunsQuery,
  collectPages,
  describeJobError,
  ERROR_MAX_CHARS,
  extractScheduleFailures,
  failuresQuery,
  findBaselineRun,
  groupByScript,
  hasOtherScheduleJob,
  latestScanPointMs,
  nextProcessedUntil,
  readProcessedUntil,
  readScanCompletedFrom,
  readScanStartedAfter,
  SCAN_LOOKBACK_MS,
  SCAN_MAX_PAGES,
  SCAN_MAX_WINDOW_MS,
  SCAN_OVERLAP_MS,
  SCAN_PAGE_SIZE,
  SCHEDULE_DETECTOR_PATH,
  scanWindow,
  scriptHistoryQuery,
  visibilityQuery,
} from "../../f/factory/lib/schedule_failure_scan.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 失敗した実行の一覧の1件。 */
function failed(
  id: string,
  completedAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    success: false,
    script_path: "f/factory/poll_prs",
    schedule_path: "f/factory/poll_prs",
    completed_at: completedAt,
    started_at: "2026-10-25T10:00:00.000Z",
    canceled: false,
    is_skipped: false,
    ...extra,
  };
}

describe("the contract constants", () => {
  test("the lookback covers the default job timeout of the instance", () => {
    // インスタンスの`job_default_timeout`(21600秒)。timeoutを持たないscriptは、この時間まで動きうる。
    expect(SCAN_LOOKBACK_MS).toBeGreaterThanOrEqual(21600 * 1000);
  });

  test("the maximum window is a day", () => {
    expect(SCAN_MAX_WINDOW_MS).toBe(24 * HOUR);
  });

  test("a page holds the maximum the API returns", () => {
    expect(SCAN_PAGE_SIZE).toBe(100);
  });

  test("the scan reads five pages at most", () => {
    expect(SCAN_MAX_PAGES).toBe(5);
  });

  test("a scan overlaps the previous one by a minute", () => {
    expect(SCAN_OVERLAP_MS).toBe(60 * 1000);
  });

  test("the detector is the script of the schedule it is set on", () => {
    expect(SCHEDULE_DETECTOR_PATH).toBe("f/factory/detect_schedule_failures");
  });
});

describe("baselineRunsQuery", () => {
  test("asks for the successful runs of the detector schedule", () => {
    expect(baselineRunsQuery("factory")).toMatchObject({
      workspace: "factory",
      schedulePath: SCHEDULE_DETECTOR_PATH,
      scriptPathExact: SCHEDULE_DETECTOR_PATH,
      success: true,
    });
  });

  test("asks for the newest runs first", () => {
    expect(baselineRunsQuery("factory").orderDesc).toBe(true);
  });

  test("leaves out skipped runs", () => {
    expect(baselineRunsQuery("factory").isSkipped).toBe(false);
  });
});

describe("findBaselineRun", () => {
  const run = (extra: Record<string, unknown> = {}) => ({
    id: "run-1",
    success: true,
    schedule_path: SCHEDULE_DETECTOR_PATH,
    started_at: "2026-10-25T11:55:00.500Z",
    ...extra,
  });

  test("returns null for an empty list", () => {
    expect(findBaselineRun([])).toBeNull();
  });

  test("returns null when the response is not a list", () => {
    expect(findBaselineRun({ runs: [] })).toBeNull();
  });

  test("returns the id of the run", () => {
    expect(findBaselineRun([run()])?.id).toBe("run-1");
  });

  test("returns the start time of the run in milliseconds", () => {
    expect(findBaselineRun([run()])?.startedAtMs).toBe(
      Date.parse("2026-10-25T11:55:00.500Z"),
    );
  });

  test("skips a run that does not belong to the detector schedule", () => {
    expect(
      findBaselineRun([
        run({ id: "manual", schedule_path: undefined }),
        run({ id: "scheduled" }),
      ])?.id,
    ).toBe("scheduled");
  });

  test("skips a run of another schedule", () => {
    expect(
      findBaselineRun([run({ schedule_path: "f/factory/poll_prs" })]),
    ).toBeNull();
  });

  test("skips a skipped run, whose success value is not a real success", () => {
    expect(findBaselineRun([run({ is_skipped: true })])).toBeNull();
  });

  test("skips a run that did not succeed", () => {
    expect(findBaselineRun([run({ success: false })])).toBeNull();
  });

  test("skips a run whose start time cannot be read", () => {
    expect(findBaselineRun([run({ started_at: "never" })])).toBeNull();
  });

  test("skips an element that is not an object", () => {
    expect(findBaselineRun([null, 3, run()])?.id).toBe("run-1");
  });
});

describe("readProcessedUntil", () => {
  const BASE = {
    id: "run-1",
    startedAtMs: NOW - 5 * MIN,
    completedAtMs: NOW - 4 * MIN,
  };

  test("reads processed_until of the result", () => {
    expect(
      readProcessedUntil({ processed_until: "2026-10-25T11:00:00.000Z" }, BASE),
    ).toBe(Date.parse("2026-10-25T11:00:00.000Z"));
  });

  test("falls back to the start time of the run without processed_until", () => {
    expect(readProcessedUntil({ recorded: 0 }, BASE)).toBe(BASE.startedAtMs);
  });

  test("falls back to the start time when processed_until is not a date", () => {
    expect(readProcessedUntil({ processed_until: "soon" }, BASE)).toBe(
      BASE.startedAtMs,
    );
  });

  test("falls back to the start time when the result is not an object", () => {
    expect(readProcessedUntil("done", BASE)).toBe(BASE.startedAtMs);
  });

  test("falls back to the start time when the result is null", () => {
    expect(readProcessedUntil(null, BASE)).toBe(BASE.startedAtMs);
  });
});

describe("scanWindow", () => {
  test("reads from the lookback before the baseline", () => {
    expect(scanWindow(NOW - HOUR, NOW).startedAfterMs).toBe(
      NOW - HOUR - SCAN_LOOKBACK_MS,
    );
  });

  test("keeps the baseline within a day", () => {
    expect(scanWindow(NOW - HOUR, NOW).baselineMs).toBe(NOW - HOUR);
  });

  test("does not clamp a baseline within a day", () => {
    expect(scanWindow(NOW - HOUR, NOW).clamped).toBe(false);
  });

  test("starts a day before now when the baseline is older than a day", () => {
    expect(scanWindow(NOW - 30 * HOUR, NOW).baselineMs).toBe(
      NOW - SCAN_MAX_WINDOW_MS,
    );
  });

  test("reports the clamp of an old baseline", () => {
    expect(scanWindow(NOW - 30 * HOUR, NOW).clamped).toBe(true);
  });

  test("reads from the lookback before the clamped baseline", () => {
    expect(scanWindow(NOW - 30 * HOUR, NOW).startedAfterMs).toBe(
      NOW - SCAN_MAX_WINDOW_MS - SCAN_LOOKBACK_MS,
    );
  });

  test("does not clamp a baseline of exactly a day", () => {
    expect(scanWindow(NOW - SCAN_MAX_WINDOW_MS, NOW).clamped).toBe(false);
  });

  test("treats a baseline in the future as now", () => {
    expect(scanWindow(NOW + HOUR, NOW).baselineMs).toBe(NOW);
  });
});

describe("scanWindow after a scan that stopped at the page limit", () => {
  const CONT = NOW - 2 * HOUR;

  test("starts at the given scan point as is, without the lookback", () => {
    expect(scanWindow(NOW - HOUR, NOW, CONT).startedAfterMs).toBe(CONT);
  });

  test("filters by the completion bound handed over from the first scan", () => {
    expect(
      scanWindow(NOW - HOUR, NOW, CONT, NOW - 3 * HOUR).completedFromMs,
    ).toBe(NOW - 3 * HOUR);
  });

  test("falls back to the baseline without a handed over completion bound", () => {
    expect(scanWindow(NOW - HOUR, NOW, CONT).completedFromMs).toBe(NOW - HOUR);
  });

  test("keeps the completion bound within a day", () => {
    expect(
      scanWindow(NOW - HOUR, NOW, CONT, NOW - 40 * HOUR).completedFromMs,
    ).toBe(NOW - SCAN_MAX_WINDOW_MS);
  });

  test("filters by the baseline without a scan point", () => {
    expect(scanWindow(NOW - HOUR, NOW).completedFromMs).toBe(NOW - HOUR);
  });

  test("starts a day before now when the scan point is older than a day", () => {
    expect(scanWindow(NOW - HOUR, NOW, NOW - 40 * HOUR).startedAfterMs).toBe(
      NOW - SCAN_MAX_WINDOW_MS,
    );
  });

  test("reports the clamp of an old scan point", () => {
    expect(scanWindow(NOW - HOUR, NOW, NOW - 40 * HOUR).clamped).toBe(true);
  });

  test("does not clamp a scan point within a day", () => {
    expect(scanWindow(NOW - HOUR, NOW, CONT).clamped).toBe(false);
  });
});

describe("latestScanPointMs", () => {
  test("is the latest creation time among the jobs, whatever their order", () => {
    expect(
      latestScanPointMs([
        { created_at: "2026-10-25T10:00:00.000Z" },
        { created_at: "2026-10-25T11:00:00.000Z" },
        { created_at: "2026-10-25T10:30:00.000Z" },
      ]),
    ).toBe(Date.parse("2026-10-25T11:00:00.000Z"));
  });

  test("uses the creation time, which no job's start precedes, so that it is safe whether the list is ordered by creation or by start", () => {
    expect(
      latestScanPointMs([
        {
          created_at: "2026-10-25T10:00:00.000Z",
          started_at: "2026-10-25T10:30:00.000Z",
        },
      ]),
    ).toBe(Date.parse("2026-10-25T10:00:00.000Z"));
  });

  test("falls back to the start when a job has no creation time", () => {
    expect(
      latestScanPointMs([{ started_at: "2026-10-25T10:00:00.000Z" }]),
    ).toBe(Date.parse("2026-10-25T10:00:00.000Z"));
  });

  test("counts jobs that the failure filter drops", () => {
    expect(
      latestScanPointMs([
        { created_at: "2026-10-25T10:00:00.000Z", is_skipped: true },
      ]),
    ).toBe(Date.parse("2026-10-25T10:00:00.000Z"));
  });

  test("ignores elements without a readable time", () => {
    expect(
      latestScanPointMs([null, { created_at: "soon" }, { id: "x" }]),
    ).toBeNull();
  });
});

describe("readScanCompletedFrom", () => {
  test("reads scan_completed_from of the result", () => {
    expect(
      readScanCompletedFrom({
        scan_completed_from: "2026-10-25T11:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-10-25T11:00:00.000Z"));
  });

  test("is null when it is empty", () => {
    expect(readScanCompletedFrom({ scan_completed_from: null })).toBeNull();
  });

  test("is null when the result is not an object", () => {
    expect(readScanCompletedFrom(null)).toBeNull();
  });
});

describe("readScanStartedAfter", () => {
  test("reads scan_started_after of the result", () => {
    expect(
      readScanStartedAfter({ scan_started_after: "2026-10-25T11:00:00.000Z" }),
    ).toBe(Date.parse("2026-10-25T11:00:00.000Z"));
  });

  test("is null when it is empty", () => {
    expect(readScanStartedAfter({ scan_started_after: null })).toBeNull();
  });

  test("is null when it is not a date", () => {
    expect(readScanStartedAfter({ scan_started_after: "soon" })).toBeNull();
  });

  test("is null when the result is not an object", () => {
    expect(readScanStartedAfter("done")).toBeNull();
  });
});

describe("failuresQuery", () => {
  const query = failuresQuery("factory", NOW - 8 * HOUR, 2);

  test("asks for failed runs only", () => {
    expect(query.success).toBe(false);
  });

  test("asks for root jobs only", () => {
    expect(query.hasNullParent).toBe(true);
  });

  test("leaves out skipped runs", () => {
    expect(query.isSkipped).toBe(false);
  });

  test("limits the scripts to the Factory folder", () => {
    expect(query.scriptPathStart).toBe("f/factory/");
  });

  test("asks for the oldest first", () => {
    expect(query.orderDesc).toBe(false);
  });

  test("asks for the maximum page size", () => {
    expect(query.perPage).toBe(100);
  });

  test("asks for the given page", () => {
    expect(query.page).toBe(2);
  });

  test("reads runs started after the given time", () => {
    expect(query.startedAfter).toBe(new Date(NOW - 8 * HOUR).toISOString());
  });

  test("names the workspace", () => {
    expect(query.workspace).toBe("factory");
  });
});

describe("extractScheduleFailures", () => {
  const BASE = NOW - HOUR;
  const T1 = new Date(NOW - 30 * MIN).toISOString();
  const T2 = new Date(NOW - 20 * MIN).toISOString();
  const T3 = new Date(NOW - 10 * MIN).toISOString();

  test("returns a failure of a schedule", () => {
    expect(extractScheduleFailures([failed("a", T1)], BASE).failures).toEqual([
      {
        id: "a",
        scriptPath: "f/factory/poll_prs",
        completedAtMs: Date.parse(T1),
        completedAt: T1,
        canceledByTimeout: false,
      },
    ]);
  });

  test("uses the script path, not the schedule path", () => {
    const job = failed("a", T1, { schedule_path: "f/factory/other_schedule" });
    expect(extractScheduleFailures([job], BASE).failures[0]?.scriptPath).toBe(
      "f/factory/poll_prs",
    );
  });

  test("leaves out a run that no schedule started", () => {
    const job = failed("a", T1, { schedule_path: undefined });
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("leaves out a run whose schedule path is empty", () => {
    const job = failed("a", T1, { schedule_path: "" });
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("leaves out a skipped run", () => {
    const job = failed("a", T1, { is_skipped: true });
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("leaves out a run a person canceled", () => {
    const job = failed("a", T1, { canceled: true, canceled_by: "admin" });
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("keeps a run canceled by the timeout", () => {
    const job = failed("a", T1, { canceled: true, canceled_by: "timeout" });
    expect(extractScheduleFailures([job], BASE).failures).toHaveLength(1);
  });

  test("marks a run canceled by the timeout", () => {
    const job = failed("a", T1, { canceled: true, canceled_by: "timeout" });
    expect(
      extractScheduleFailures([job], BASE).failures[0]?.canceledByTimeout,
    ).toBe(true);
  });

  test("leaves out a run that succeeded when the server ignored the filter", () => {
    const job = failed("a", T1, { success: true });
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("leaves out a run completed before the baseline", () => {
    const job = failed("a", new Date(BASE - 1).toISOString());
    expect(extractScheduleFailures([job], BASE).failures).toEqual([]);
  });

  test("keeps a run completed at the baseline", () => {
    const job = failed("a", new Date(BASE).toISOString());
    expect(extractScheduleFailures([job], BASE).failures).toHaveLength(1);
  });

  test("keeps one failure when the same job comes twice, as when a page shifts", () => {
    expect(
      extractScheduleFailures([failed("a", T1), failed("a", T1)], BASE)
        .failures,
    ).toHaveLength(1);
  });

  test("keeps the other failures next to a repeated one", () => {
    expect(
      extractScheduleFailures(
        [failed("a", T1), failed("b", T2), failed("a", T1)],
        BASE,
      ).failures.map((f) => f.id),
    ).toEqual(["a", "b"]);
  });

  test("sorts the failures oldest first by completion", () => {
    const jobs = [failed("c", T3), failed("a", T1), failed("b", T2)];
    expect(
      extractScheduleFailures(jobs, BASE).failures.map((f) => f.id),
    ).toEqual(["a", "b", "c"]);
  });

  test("orders failures completed at the same time by id", () => {
    const jobs = [failed("b", T1), failed("a", T1)];
    expect(
      extractScheduleFailures(jobs, BASE).failures.map((f) => f.id),
    ).toEqual(["a", "b"]);
  });

  test("counts an element that is not an object as malformed", () => {
    expect(extractScheduleFailures([null, "x"], BASE).malformed).toBe(2);
  });

  test("counts a failure without an id as malformed", () => {
    const job = failed("a", T1, { id: undefined });
    expect(extractScheduleFailures([job], BASE).malformed).toBe(1);
  });

  test("counts a failure without a script path as malformed", () => {
    const job = failed("a", T1, { script_path: undefined });
    expect(extractScheduleFailures([job], BASE).malformed).toBe(1);
  });

  test("counts a failure whose completion time cannot be read as malformed", () => {
    const job = failed("a", "yesterday");
    expect(extractScheduleFailures([job], BASE).malformed).toBe(1);
  });

  test("counts a failure without a completion time as malformed", () => {
    const job = failed("a", T1, { completed_at: undefined });
    expect(extractScheduleFailures([job], BASE).malformed).toBe(1);
  });

  test("does not count a manual run as malformed", () => {
    const job = failed("a", "yesterday", { schedule_path: undefined });
    expect(extractScheduleFailures([job], BASE).malformed).toBe(0);
  });

  test("keeps the readable failures next to a malformed element", () => {
    expect(
      extractScheduleFailures([null, failed("a", T1)], BASE).failures,
    ).toHaveLength(1);
  });

  test("reads a completion time with microseconds", () => {
    const job = failed("a", "2026-10-25T11:40:00.123456Z");
    expect(
      extractScheduleFailures([job], BASE).failures[0]?.completedAtMs,
    ).toBe(Date.parse("2026-10-25T11:40:00.123Z"));
  });
});

describe("groupByScript", () => {
  const f = (id: string, scriptPath: string) => ({
    id,
    scriptPath,
    completedAtMs: 0,
    completedAt: "",
    canceledByTimeout: false,
  });

  test("groups the failures by script path", () => {
    const groups = groupByScript([f("1", "x"), f("2", "y"), f("3", "x")]);
    expect(groups.get("x")?.map((job) => job.id)).toEqual(["1", "3"]);
  });

  test("keeps the order of the first appearance of each script", () => {
    const groups = groupByScript([f("1", "y"), f("2", "x"), f("3", "y")]);
    expect([...groups.keys()]).toEqual(["y", "x"]);
  });

  test("returns no group for no failure", () => {
    expect(groupByScript([]).size).toBe(0);
  });
});

describe("visibilityQuery", () => {
  test("asks for root jobs of the Factory folder after the given time", () => {
    expect(visibilityQuery("factory", NOW - 15 * MIN)).toMatchObject({
      workspace: "factory",
      hasNullParent: true,
      scriptPathStart: "f/factory/",
      startedAfter: new Date(NOW - 15 * MIN).toISOString(),
    });
  });
});

describe("hasOtherScheduleJob", () => {
  const job = (extra: Record<string, unknown> = {}) => ({
    script_path: "f/factory/poll_prs",
    schedule_path: "f/factory/poll_prs",
    ...extra,
  });

  test("is true when a job of another schedule is visible", () => {
    expect(hasOtherScheduleJob([job()])).toBe(true);
  });

  test("is false for an empty list", () => {
    expect(hasOtherScheduleJob([])).toBe(false);
  });

  test("is false when only the detector runs are visible", () => {
    expect(
      hasOtherScheduleJob([job({ script_path: SCHEDULE_DETECTOR_PATH })]),
    ).toBe(false);
  });

  test("is false when only runs without a schedule are visible", () => {
    expect(hasOtherScheduleJob([job({ schedule_path: undefined })])).toBe(
      false,
    );
  });

  test("is false when the response is not a list", () => {
    expect(hasOtherScheduleJob({ jobs: [job()] })).toBe(false);
  });

  test("is true when another job is next to the detector runs", () => {
    expect(
      hasOtherScheduleJob([
        job({ script_path: SCHEDULE_DETECTOR_PATH }),
        job(),
      ]),
    ).toBe(true);
  });
});

describe("scriptHistoryQuery", () => {
  test("asks for the newest runs of the script without skipped ones", () => {
    expect(scriptHistoryQuery("factory", "f/factory/poll_prs")).toMatchObject({
      workspace: "factory",
      scriptPathExact: "f/factory/poll_prs",
      orderDesc: true,
      isSkipped: false,
      perPage: 10,
    });
  });
});

describe("describeJobError", () => {
  test("reads the message of the error in the result", () => {
    expect(
      describeJobError({
        result: { error: { message: "boom", name: "Error" } },
      }),
    ).toBe("Error: boom");
  });

  test("reads the message without a name", () => {
    expect(describeJobError({ result: { error: { message: "boom" } } })).toBe(
      "boom",
    );
  });

  test("reads an error that is a string", () => {
    expect(describeJobError({ result: { error: "boom" } })).toBe("boom");
  });

  test("reads a result that is a string", () => {
    expect(describeJobError({ result: "boom" })).toBe("boom");
  });

  test("serializes a result of another shape", () => {
    expect(describeJobError({ result: { code: 7 } })).toBe('{"code":7}');
  });

  test("names the cancel reason when the job has no result", () => {
    expect(
      describeJobError({ canceled: true, canceled_reason: "too slow" }),
    ).toBe("canceled: too slow");
  });

  test("names the timeout when the job was canceled by it", () => {
    expect(describeJobError({ canceled: true, canceled_by: "timeout" })).toBe(
      "canceled by timeout",
    );
  });

  test("says the error is unreadable for a job without any information", () => {
    expect(describeJobError({})).toBe(
      "the job failed without a readable error",
    );
  });

  test("says the error is unreadable when the job is not an object", () => {
    expect(describeJobError(null)).toBe(
      "the job failed without a readable error",
    );
  });

  test("masks a secret in the message", () => {
    const token = `ghp_${"a".repeat(30)}`;
    expect(describeJobError({ result: { error: { message: token } } })).toBe(
      "***",
    );
  });

  test("removes a NUL character, which a text column cannot hold", () => {
    expect(
      describeJobError({ result: { error: { message: "a\u0000b" } } }),
    ).toBe("ab");
  });

  test("removes other control characters", () => {
    expect(
      describeJobError({
        result: { error: { message: "a\u0001b\u001bc\u007fd" } },
      }),
    ).toBe("abcd");
  });

  test("keeps a line break and a tab", () => {
    expect(
      describeJobError({ result: { error: { message: "a\nb\tc" } } }),
    ).toBe("a\nb\tc");
  });

  test("removes control characters from the cancel reason too", () => {
    expect(
      describeJobError({ canceled: true, canceled_reason: "x\u0000y" }),
    ).toBe("canceled: xy");
  });

  test("removes a control character inside a secret before masking, so that the mask still applies", () => {
    const token = `ghp_${"a".repeat(15)}\u0000${"a".repeat(15)}`;
    expect(describeJobError({ result: { error: { message: token } } })).toBe(
      "***",
    );
  });

  test("cuts a long message", () => {
    const long = "x".repeat(ERROR_MAX_CHARS + 500);
    expect(
      Array.from(describeJobError({ result: { error: { message: long } } }))
        .length,
    ).toBe(ERROR_MAX_CHARS);
  });

  test("keeps a message of the maximum length", () => {
    const exact = "x".repeat(ERROR_MAX_CHARS);
    expect(describeJobError({ result: { error: { message: exact } } })).toBe(
      exact,
    );
  });
});

describe("collectPages", () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i) }));

  test("reads one page when it is not full", async () => {
    const pages: number[] = [];
    await collectPages(async (p) => {
      pages.push(p);
      return page(3);
    });
    expect(pages).toEqual([1]);
  });

  test("returns the jobs of a page that is not full", async () => {
    const result = await collectPages(async () => page(3));
    expect(result.jobs).toHaveLength(3);
  });

  test("is not truncated when the last page is not full", async () => {
    const result = await collectPages(async () => page(3));
    expect(result.truncated).toBe(false);
  });

  test("reads the next page when a page is full", async () => {
    const pages: number[] = [];
    await collectPages(async (p) => {
      pages.push(p);
      return p === 1 ? page(SCAN_PAGE_SIZE) : page(2);
    });
    expect(pages).toEqual([1, 2]);
  });

  test("joins the pages in order", async () => {
    const result = await collectPages(async (p) =>
      p === 1 ? page(SCAN_PAGE_SIZE) : page(2),
    );
    expect(result.jobs).toHaveLength(SCAN_PAGE_SIZE + 2);
  });

  test("stops at the maximum number of pages", async () => {
    const pages: number[] = [];
    await collectPages(async (p) => {
      pages.push(p);
      return page(SCAN_PAGE_SIZE);
    });
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  test("is truncated when the last allowed page is full", async () => {
    const result = await collectPages(async () => page(SCAN_PAGE_SIZE));
    expect(result.truncated).toBe(true);
  });

  test("is not truncated when the last allowed page is not full", async () => {
    const result = await collectPages(async (p) =>
      p < SCAN_MAX_PAGES ? page(SCAN_PAGE_SIZE) : page(5),
    );
    expect(result.truncated).toBe(false);
  });

  test("throws when a page is not a list", async () => {
    await expect(collectPages(async () => ({ jobs: [] }))).rejects.toThrow(
      "not a list",
    );
  });

  test("passes through the error of a page", async () => {
    await expect(
      collectPages(async () => {
        throw new Error("api down");
      }),
    ).rejects.toThrow("api down");
  });
});

describe("nextProcessedUntil", () => {
  const BASELINE = NOW - 30 * MIN;
  const input = (extra: { baselineMs?: number; continued?: boolean }) => ({
    baselineMs: BASELINE,
    runStartedAtMs: NOW,
    continued: false,
    ...extra,
  });

  test("overlaps the previous scan by the margin, whether or not the pages ran out", () => {
    expect(nextProcessedUntil(input({}))).toBe(NOW - SCAN_OVERLAP_MS);
  });

  test("never moves back before the baseline", () => {
    expect(nextProcessedUntil(input({ baselineMs: NOW }))).toBe(NOW);
  });

  test("stays at the baseline in a scan that continues from a start time", () => {
    expect(nextProcessedUntil(input({ continued: true }))).toBe(BASELINE);
  });
});
