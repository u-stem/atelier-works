import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  allRecentRunsFailed,
  buildScheduleFailingNotice,
  flagFailingSchedule,
  SCHEDULE_FAILING_CHECK_FAILED_NOTICE,
  SCHEDULE_FAILING_FETCH_COUNT,
  SCHEDULE_FAILING_RUNS,
} from "../../f/factory/lib/schedule_failing.ts";
import { isRecord, type NoticeRecord } from "../../f/factory/lib/types.ts";

const FAILED = { success: false, canceled: false };
const SUCCEEDED = { success: true, canceled: false };
const SKIPPED = { success: false, canceled: false, is_skipped: true };
const CANCELED = { success: false, canceled: true };

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
