import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  buildScheduleFailingNotice,
  flagFailingSchedule,
  isScheduleFailing,
  SCHEDULE_FAILING_THRESHOLD,
  SCHEDULE_FAILING_WINDOW_HOURS,
} from "../../f/factory/lib/schedule_failing.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("isScheduleFailing", () => {
  test("is false below the threshold", () => {
    expect(isScheduleFailing(SCHEDULE_FAILING_THRESHOLD - 1)).toBe(false);
  });

  test("is true at the threshold", () => {
    expect(isScheduleFailing(SCHEDULE_FAILING_THRESHOLD)).toBe(true);
  });

  test("is true above the threshold", () => {
    expect(isScheduleFailing(SCHEDULE_FAILING_THRESHOLD + 5)).toBe(true);
  });

  test("uses three failures in twenty-four hours", () => {
    expect([SCHEDULE_FAILING_THRESHOLD, SCHEDULE_FAILING_WINDOW_HOURS]).toEqual(
      [3, 24],
    );
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

type Harness = {
  readonly deps: Parameters<typeof flagFailingSchedule>[2];
  readonly sinceArgs: { path: string; since: Date }[];
  readonly notices: NoticeRecord[];
};

function harness(options: {
  readonly count?: number;
  readonly countThrows?: boolean;
  readonly addNoticeThrows?: boolean;
}): Harness {
  const sinceArgs: { path: string; since: Date }[] = [];
  const notices: NoticeRecord[] = [];
  return {
    sinceArgs,
    notices,
    deps: {
      countFailuresSince: async (path, since) => {
        sinceArgs.push({ path, since });
        if (options.countThrows === true) throw new Error("db down");
        return options.count ?? 0;
      },
      addNotice: async (record) => {
        if (options.addNoticeThrows === true) throw new Error("db down");
        notices.push(record);
        return 1;
      },
      log: logger("test", { sink: () => undefined }),
    },
  };
}

describe("flagFailingSchedule", () => {
  test("adds the notice at three failures", async () => {
    const h = harness({ count: 3 });
    await flagFailingSchedule("f/factory/poll_issues", NOW, h.deps);
    expect(h.notices).toEqual([
      buildScheduleFailingNotice("f/factory/poll_issues"),
    ]);
  });

  test("adds no notice at two failures", async () => {
    const h = harness({ count: 2 });
    await flagFailingSchedule("f/factory/poll_issues", NOW, h.deps);
    expect(h.notices).toEqual([]);
  });

  test("counts failures since twenty-four hours ago", async () => {
    const h = harness({ count: 3 });
    await flagFailingSchedule("f/factory/poll_issues", NOW, h.deps);
    expect(h.sinceArgs).toEqual([
      {
        path: "f/factory/poll_issues",
        since: new Date("2026-10-08T12:00:00.000Z"),
      },
    ]);
  });

  test("returns true when it flagged the schedule", async () => {
    const h = harness({ count: 4 });
    expect(await flagFailingSchedule("f/factory/a", NOW, h.deps)).toBe(true);
  });

  test("returns false below the threshold", async () => {
    const h = harness({ count: 1 });
    expect(await flagFailingSchedule("f/factory/a", NOW, h.deps)).toBe(false);
  });

  test("skips an unknown schedule path", async () => {
    const h = harness({ count: 9 });
    await flagFailingSchedule("unknown", NOW, h.deps);
    expect(h.sinceArgs).toEqual([]);
  });

  test("does not throw when the count fails", async () => {
    const h = harness({ countThrows: true });
    expect(await flagFailingSchedule("f/factory/a", NOW, h.deps)).toBe(false);
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ count: 3, addNoticeThrows: true });
    expect(await flagFailingSchedule("f/factory/a", NOW, h.deps)).toBe(false);
  });
});
