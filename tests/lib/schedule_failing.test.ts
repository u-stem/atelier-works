import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  allRecentRunsFailed,
  buildScheduleFailingNotice,
  flagFailingSchedule,
  previousFailedRunId,
  SCHEDULE_FAILING_CHECK_FAILED_NOTICE,
  SCHEDULE_FAILING_FETCH_COUNT,
  SCHEDULE_FAILING_RUNS,
  shouldNotifyJobFailed,
} from "../../f/factory/lib/schedule_failing.ts";
import { isRecord, type NoticeRecord } from "../../f/factory/lib/types.ts";

const FAILED = { success: false, canceled: false };
const SUCCEEDED = { success: true, canceled: false };
const SKIPPED = { success: false, canceled: false, is_skipped: true };
const CANCELED = { success: false, canceled: true };
const CANCELED_BY_PERSON = {
  success: false,
  canceled: true,
  canceled_by: "admin@example.com",
  canceled_reason: "timeout while waiting",
};
const CANCELED_BY_TIMEOUT = {
  success: false,
  canceled: true,
  canceled_by: "timeout",
};

describe("allRecentRunsFailed", () => {
  test("is true when the last three runs all failed", () => {
    expect(allRecentRunsFailed([FAILED, FAILED, FAILED])).toBe(true);
  });

  test("is false when one of the last three runs succeeded", () => {
    expect(allRecentRunsFailed([FAILED, SUCCEEDED, FAILED])).toBe(false);
  });

  test("is false when the newest run succeeded", () => {
    expect(allRecentRunsFailed([SUCCEEDED, FAILED, FAILED])).toBe(false);
  });

  test("is false when fewer than three runs exist", () => {
    expect(allRecentRunsFailed([FAILED, FAILED])).toBe(false);
  });

  test("is false for an empty list", () => {
    expect(allRecentRunsFailed([])).toBe(false);
  });

  test("does not count a canceled run as a failure", () => {
    expect(allRecentRunsFailed([FAILED, CANCELED, FAILED])).toBe(false);
  });

  test("does not let a canceled run break the streak", () => {
    expect(allRecentRunsFailed([FAILED, CANCELED, FAILED, FAILED])).toBe(true);
  });

  test("counts runs canceled by the timeout as failures", () => {
    expect(
      allRecentRunsFailed([CANCELED_BY_TIMEOUT, CANCELED_BY_TIMEOUT, FAILED]),
    ).toBe(true);
  });

  test("keeps the streak across a run canceled by the timeout", () => {
    expect(
      allRecentRunsFailed([FAILED, CANCELED_BY_TIMEOUT, FAILED, SUCCEEDED]),
    ).toBe(true);
  });

  test("is false when a success sits among runs canceled by the timeout", () => {
    expect(
      allRecentRunsFailed([
        CANCELED_BY_TIMEOUT,
        SUCCEEDED,
        CANCELED_BY_TIMEOUT,
      ]),
    ).toBe(false);
  });

  test("does not count a run canceled by a person even if the reason mentions a timeout", () => {
    expect(allRecentRunsFailed([FAILED, CANCELED_BY_PERSON, FAILED])).toBe(
      false,
    );
  });

  test("does not count a canceled run whose canceled_by is not a string", () => {
    expect(
      allRecentRunsFailed([
        FAILED,
        { success: false, canceled: true, canceled_by: 1 },
        FAILED,
      ]),
    ).toBe(false);
  });

  test("is false when a run canceled by the timeout reports success", () => {
    expect(
      allRecentRunsFailed([
        FAILED,
        { success: true, canceled: true, canceled_by: "timeout" },
        FAILED,
      ]),
    ).toBe(false);
  });

  test("ignores canceled runs at the head of the list", () => {
    expect(
      allRecentRunsFailed([CANCELED, SKIPPED, FAILED, FAILED, FAILED]),
    ).toBe(true);
  });

  test("judges a response the server did not filter the same way", () => {
    expect(
      allRecentRunsFailed([
        SKIPPED,
        CANCELED,
        SKIPPED,
        FAILED,
        FAILED,
        FAILED,
        SUCCEEDED,
      ]),
    ).toBe(true);
  });

  test("is false when a succeeded run follows the skipped and canceled ones", () => {
    expect(
      allRecentRunsFailed([SKIPPED, CANCELED, FAILED, FAILED, SUCCEEDED]),
    ).toBe(false);
  });

  test("is false when a run has no boolean success", () => {
    expect(allRecentRunsFailed([FAILED, { canceled: false }, FAILED])).toBe(
      false,
    );
  });

  test("is false when the success flag is a string", () => {
    expect(
      allRecentRunsFailed([
        FAILED,
        { success: "false", canceled: false },
        FAILED,
      ]),
    ).toBe(false);
  });

  test("is false when a run is not an object", () => {
    expect(allRecentRunsFailed([FAILED, null, FAILED])).toBe(false);
  });

  test("is false when the response is not an array", () => {
    expect(allRecentRunsFailed({ jobs: [FAILED, FAILED, FAILED] })).toBe(false);
  });

  test("does not let a skipped run break the streak", () => {
    expect(allRecentRunsFailed([FAILED, SKIPPED, FAILED, FAILED])).toBe(true);
  });

  test("does not count a skipped run as a failure", () => {
    expect(allRecentRunsFailed([FAILED, SKIPPED, FAILED])).toBe(false);
  });

  test("ignores skipped runs at the head of the list", () => {
    expect(
      allRecentRunsFailed([SKIPPED, SKIPPED, FAILED, FAILED, FAILED]),
    ).toBe(true);
  });

  test("counts a run whose is_skipped is false", () => {
    expect(
      allRecentRunsFailed([{ ...FAILED, is_skipped: false }, FAILED, FAILED]),
    ).toBe(true);
  });

  test("looks at the newest three runs only", () => {
    expect(allRecentRunsFailed([FAILED, FAILED, FAILED, SUCCEEDED])).toBe(true);
  });

  test("requires three runs", () => {
    expect(SCHEDULE_FAILING_RUNS).toBe(3);
  });

  test("fetches ten runs so that skipped and canceled ones can be dropped", () => {
    expect(SCHEDULE_FAILING_FETCH_COUNT).toBe(10);
  });
});

describe("buildScheduleFailingNotice", () => {
  test("uses the schedule_failing kind", () => {
    expect(buildScheduleFailingNotice("f/factory/poll_issues").kind).toBe(
      "schedule_failing",
    );
  });

  test("names the schedule", () => {
    expect(
      buildScheduleFailingNotice("f/factory/poll_issues").message,
    ).toContain("f/factory/poll_issues");
  });

  test("says the last three runs failed in a row", () => {
    expect(buildScheduleFailingNotice("f/factory/a").message).toContain(
      "直近3回の実行が続けて失敗しています",
    );
  });

  test("is the same text on every call for one schedule", () => {
    expect(buildScheduleFailingNotice("f/factory/poll_issues")).toEqual(
      buildScheduleFailingNotice("f/factory/poll_issues"),
    );
  });

  test("differs between schedules", () => {
    expect(buildScheduleFailingNotice("f/factory/a").message).not.toBe(
      buildScheduleFailingNotice("f/factory/b").message,
    );
  });

  test("is an action notice", () => {
    expect(noticeSeverity("schedule_failing")).toBe("action");
  });
});

describe("SCHEDULE_FAILING_CHECK_FAILED_NOTICE", () => {
  test("uses the schedule_failing_check_failed kind", () => {
    expect(SCHEDULE_FAILING_CHECK_FAILED_NOTICE.kind).toBe(
      "schedule_failing_check_failed",
    );
  });

  test("is an action notice", () => {
    expect(noticeSeverity("schedule_failing_check_failed")).toBe("action");
  });

  test("tells the operator to check the permission", () => {
    expect(SCHEDULE_FAILING_CHECK_FAILED_NOTICE.message).toContain("権限");
  });

  test("does not depend on a schedule or an error", () => {
    expect(SCHEDULE_FAILING_CHECK_FAILED_NOTICE.message).not.toContain(
      "f/factory",
    );
  });
});

type Harness = {
  readonly deps: Parameters<typeof flagFailingSchedule>[1];
  readonly asked: { path: string; count: number }[];
  readonly notices: NoticeRecord[];
  readonly messages: string[];
};

function harness(options: {
  readonly runs?: unknown;
  readonly listThrows?: boolean;
  readonly addNoticeThrows?: boolean;
}): Harness {
  const asked: { path: string; count: number }[] = [];
  const notices: NoticeRecord[] = [];
  const messages: string[] = [];
  return {
    asked,
    notices,
    messages,
    deps: {
      listRecentRuns: async (path, count) => {
        asked.push({ path, count });
        if (options.listThrows === true) throw new Error("api down");
        return options.runs ?? [];
      },
      addNotice: async (record) => {
        if (options.addNoticeThrows === true) throw new Error("db down");
        notices.push(record);
        return 1;
      },
      log: logger("test", {
        sink: (line) => {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed) && typeof parsed.message === "string") {
            messages.push(parsed.message);
          }
        },
      }),
    },
  };
}

describe("flagFailingSchedule", () => {
  test("adds the notice when the last three runs failed", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    await flagFailingSchedule("f/factory/poll_issues", h.deps);
    expect(h.notices).toEqual([
      buildScheduleFailingNotice("f/factory/poll_issues"),
    ]);
  });

  test("adds no notice when a recent run succeeded", async () => {
    const h = harness({ runs: [FAILED, SUCCEEDED, FAILED] });
    await flagFailingSchedule("f/factory/poll_issues", h.deps);
    expect(h.notices).toEqual([]);
  });

  test("asks for the newest ten runs of the schedule", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    await flagFailingSchedule("f/factory/poll_issues", h.deps);
    expect(h.asked).toEqual([{ path: "f/factory/poll_issues", count: 10 }]);
  });

  test("returns true when it flagged the schedule", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(true);
  });

  test("returns false when a run succeeded", async () => {
    const h = harness({ runs: [SUCCEEDED, FAILED, FAILED] });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(false);
  });

  test("skips an unknown schedule path", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    await flagFailingSchedule("unknown", h.deps);
    expect(h.asked).toEqual([]);
  });

  test("returns false when the API fails", async () => {
    const h = harness({ listThrows: true });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(false);
  });

  test("leaves the fixed check failed notice when the API fails", async () => {
    const h = harness({ listThrows: true });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.notices).toEqual([SCHEDULE_FAILING_CHECK_FAILED_NOTICE]);
  });

  test("keeps the API error text out of the check failed notice", async () => {
    const h = harness({ listThrows: true });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(JSON.stringify(h.notices)).not.toContain("api down");
  });

  test("leaves the check failed notice for a response of the wrong shape", async () => {
    const h = harness({ runs: { jobs: [] } });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.notices).toEqual([SCHEDULE_FAILING_CHECK_FAILED_NOTICE]);
  });

  test("returns false for a response of the wrong shape", async () => {
    const h = harness({ runs: { jobs: [] } });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(false);
  });

  test("logs a read failure when the response has the wrong shape", async () => {
    const h = harness({ runs: { jobs: [] } });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.messages).toEqual(["failed to read the schedule history"]);
  });

  test("logs a read failure when the API fails", async () => {
    const h = harness({ listThrows: true });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.messages).toEqual(["failed to read the schedule history"]);
  });

  test("logs a different message when the failing notice cannot be recorded", async () => {
    const h = harness({
      runs: [FAILED, FAILED, FAILED],
      addNoticeThrows: true,
    });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.messages).toEqual([
      "failed to record the schedule failing notice",
    ]);
  });

  test("logs when the check failed notice cannot be recorded", async () => {
    const h = harness({ listThrows: true, addNoticeThrows: true });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.messages).toEqual([
      "failed to read the schedule history",
      "failed to record the schedule check failure",
    ]);
  });

  test("logs nothing when the schedule is healthy", async () => {
    const h = harness({ runs: [SUCCEEDED, FAILED, FAILED] });
    await flagFailingSchedule("f/factory/a", h.deps);
    expect(h.messages).toEqual([]);
  });

  test("does not throw when the check failed notice cannot be recorded", async () => {
    const h = harness({ listThrows: true, addNoticeThrows: true });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(false);
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({
      runs: [FAILED, FAILED, FAILED],
      addNoticeThrows: true,
    });
    expect(await flagFailingSchedule("f/factory/a", h.deps)).toBe(false);
  });
});

const run = (id: string, base: Record<string, unknown>) => ({ id, ...base });

describe("previousFailedRunId", () => {
  test("is null when the previous run succeeded", () => {
    expect(
      previousFailedRunId([run("b", FAILED), run("a", SUCCEEDED)], "b"),
    ).toBeNull();
  });

  test("returns the id of the previous run when it failed", () => {
    expect(previousFailedRunId([run("b", FAILED), run("a", FAILED)], "b")).toBe(
      "a",
    );
  });

  test("is null when there is no previous run", () => {
    expect(previousFailedRunId([run("b", FAILED)], "b")).toBeNull();
  });

  test("looks before the failed job when it is not the first entry", () => {
    expect(
      previousFailedRunId(
        [run("c", FAILED), run("b", FAILED), run("a", SUCCEEDED)],
        "b",
      ),
    ).toBeNull();
  });

  test("is null when the known job is not listed", () => {
    expect(
      previousFailedRunId([run("x", FAILED), run("y", FAILED)], "b"),
    ).toBeNull();
  });

  test("takes the entry after the first when the job id is unknown", () => {
    expect(
      previousFailedRunId([run("x", FAILED), run("y", FAILED)], "unknown"),
    ).toBe("y");
  });

  test("skips a skipped run", () => {
    expect(
      previousFailedRunId(
        [run("c", FAILED), run("s", SKIPPED), run("a", SUCCEEDED)],
        "c",
      ),
    ).toBeNull();
  });

  test("skips a run canceled by a person", () => {
    expect(
      previousFailedRunId(
        [run("c", FAILED), run("p", CANCELED_BY_PERSON), run("a", FAILED)],
        "c",
      ),
    ).toBe("a");
  });

  test("is null when the response is not a list", () => {
    expect(previousFailedRunId(null, "b")).toBeNull();
  });
});

describe("shouldNotifyJobFailed", () => {
  const afterSuccess = [run("b", FAILED), run("a", SUCCEEDED)];
  const afterFailure = [run("b", FAILED), run("a", FAILED)];
  const recorded = { job_id: "a", error: "boom" };

  test("notifies the first failure of a streak", () => {
    expect(
      shouldNotifyJobFailed({
        runs: afterSuccess,
        jobId: "b",
        previousFailure: recorded,
        currentError: "boom",
      }),
    ).toBe(true);
  });

  test("does not notify a repeated failure with the same error", () => {
    expect(
      shouldNotifyJobFailed({
        runs: afterFailure,
        jobId: "b",
        previousFailure: recorded,
        currentError: "boom",
      }),
    ).toBe(false);
  });

  test("notifies a repeated failure whose error changed", () => {
    expect(
      shouldNotifyJobFailed({
        runs: afterFailure,
        jobId: "b",
        previousFailure: recorded,
        currentError: "bang",
      }),
    ).toBe(true);
  });

  test("notifies when the previous failure is unknown", () => {
    expect(
      shouldNotifyJobFailed({
        runs: afterFailure,
        jobId: "b",
        previousFailure: null,
        currentError: "boom",
      }),
    ).toBe(true);
  });

  test("notifies when the recorded failure belongs to another run", () => {
    expect(
      shouldNotifyJobFailed({
        runs: afterFailure,
        jobId: "b",
        previousFailure: { job_id: "old", error: "boom" },
        currentError: "boom",
      }),
    ).toBe(true);
  });

  test("notifies when the history could not be read", () => {
    expect(
      shouldNotifyJobFailed({
        runs: null,
        jobId: "b",
        previousFailure: recorded,
        currentError: "boom",
      }),
    ).toBe(true);
  });
});

describe("flagFailingSchedule announcement", () => {
  test("announces a newly inserted failing notice", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    let announced = 0;
    await flagFailingSchedule("f/factory/a", {
      ...h.deps,
      onFailingNoticeInserted: async () => {
        announced += 1;
      },
    });
    expect(announced).toBe(1);
  });

  test("does not announce when the notice already exists", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    let announced = 0;
    await flagFailingSchedule("f/factory/a", {
      ...h.deps,
      addNotice: async () => null,
      onFailingNoticeInserted: async () => {
        announced += 1;
      },
    });
    expect(announced).toBe(0);
  });

  test("still returns true when the announcement throws", async () => {
    const h = harness({ runs: [FAILED, FAILED, FAILED] });
    expect(
      await flagFailingSchedule("f/factory/a", {
        ...h.deps,
        onFailingNoticeInserted: async () => {
          throw new Error("discord down");
        },
      }),
    ).toBe(true);
  });
});
