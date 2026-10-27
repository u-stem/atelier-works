import { describe, expect, test } from "bun:test";
import {
  ACTIVE_READ_FAILED_NOTE,
  activityWords,
  SCHEDULE_READ_FAILED_NOTE,
  scheduleRunWords,
} from "./flowGraphText.ts";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("activityWords", () => {
  test("says a running flow is running", () => {
    expect(
      activityWords({ running: 1, queued: 0, runningJobId: ID }, false).running,
    ).toBe("実行中");
  });

  test("says nothing about a flow that does not run", () => {
    expect(
      activityWords({ running: 0, queued: 2, runningJobId: null }, false)
        .running,
    ).toBeNull();
  });

  test("counts the jobs that wait", () => {
    expect(
      activityWords({ running: 0, queued: 3, runningJobId: null }, false)
        .queued,
    ).toBe("待ち3");
  });

  test("adds a lower bound to the count of waiting jobs", () => {
    expect(
      activityWords({ running: 0, queued: 3, runningJobId: null }, true).queued,
    ).toBe("待ち3以上");
  });

  test("says nothing about a flow that nobody waits for", () => {
    expect(
      activityWords({ running: 1, queued: 0, runningJobId: ID }, true).queued,
    ).toBeNull();
  });

  test("says nothing for a flow with no activity", () => {
    expect(activityWords(undefined, false)).toEqual({
      running: null,
      queued: null,
    });
  });
});

describe("scheduleRunWords", () => {
  test("says the last run succeeded", () => {
    expect(scheduleRunWords({ success: true })).toBe("直近 成功");
  });

  test("says the last run failed or was canceled", () => {
    expect(scheduleRunWords({ success: false })).toBe("直近 失敗・取消");
  });

  test("says nothing for a schedule that has not run", () => {
    expect(scheduleRunWords(undefined)).toBeNull();
  });
});

describe("the notes of a read that failed", () => {
  test("tells that the state of the runs could not be read", () => {
    expect(ACTIVE_READ_FAILED_NOTE).toBe("実行の状態を読めませんでした");
  });

  test("tells that the last results of the schedules could not be read", () => {
    expect(SCHEDULE_READ_FAILED_NOTE).toBe(
      "定期の入口の直近の結果を読めませんでした",
    );
  });
});
