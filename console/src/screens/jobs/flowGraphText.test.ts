import { describe, expect, test } from "bun:test";
import type { FlowGraphState, NodeActivity } from "../../lib/flowOverlay.ts";
import {
  ACTIVE_READ_FAILED_NOTE,
  activityWords,
  overviewWords,
  QUEUE_TRUNCATED_NOTE,
  SCHEDULE_READ_FAILED_NOTE,
  SCHEDULE_TRUNCATED_NOTE,
  scheduleWords,
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

describe("scheduleWords", () => {
  const active = { stopped: false, lastRun: null, nextRunAt: null };

  test("says the last run succeeded", () => {
    expect(scheduleWords({ ...active, lastRun: { success: true } }).last).toBe(
      "直近 成功",
    );
  });

  test("says the last run failed or was canceled", () => {
    expect(scheduleWords({ ...active, lastRun: { success: false } }).last).toBe(
      "直近 失敗・取消",
    );
  });

  test("says a stopped schedule is stopped, whatever its last run was", () => {
    expect(
      scheduleWords({
        stopped: true,
        lastRun: { success: true },
        nextRunAt: null,
      }).last,
    ).toBe("停止中");
  });

  test("marks a stopped schedule", () => {
    expect(
      scheduleWords({ stopped: true, lastRun: null, nextRunAt: null }).stopped,
    ).toBe(true);
  });

  test("does not add the next run to a stopped schedule", () => {
    expect(
      scheduleWords({
        stopped: true,
        lastRun: null,
        nextRunAt: "2026-10-27T03:05:00Z",
      }).next,
    ).toBeNull();
  });

  test("writes the next run in Japan time", () => {
    expect(
      scheduleWords({ ...active, nextRunAt: "2026-10-27T03:05:00Z" }).next,
    ).toBe("次回 12:05");
  });

  test("does not write a next run it cannot read", () => {
    expect(scheduleWords({ ...active, nextRunAt: "soon" }).next).toBeNull();
  });

  test("says nothing about the last run of a schedule that has not run", () => {
    expect(scheduleWords(active).last).toBeNull();
  });

  test("says nothing for a schedule that was not read", () => {
    expect(scheduleWords(undefined)).toEqual({
      last: null,
      next: null,
      stopped: false,
    });
  });
});

describe("overviewWords", () => {
  const state = (overrides: Partial<FlowGraphState> = {}): FlowGraphState => ({
    overlay: { activity: new Map(), lowerBound: false },
    scheduleEntries: null,
    activeFailed: false,
    schedulesFailed: false,
    activePending: false,
    schedulesTruncated: false,
    ...overrides,
  });
  const activity = (entries: Record<string, NodeActivity>) =>
    new Map(Object.entries(entries));

  test("says it is reading while the jobs have not arrived", () => {
    expect(overviewWords(state({ overlay: null, activePending: true }))).toBe(
      "取得中",
    );
  });

  test("says that no flow is running when nothing was found", () => {
    expect(overviewWords(state())).toBe("いま動いているflowはありません");
  });

  test("counts the running and waiting jobs over all flows", () => {
    expect(
      overviewWords(
        state({
          overlay: {
            activity: activity({
              "flow:pipeline": { running: 1, queued: 0, runningJobId: ID },
              "flow:pr_fix": { running: 1, queued: 1, runningJobId: ID },
            }),
            lowerBound: false,
          },
        }),
      ),
    ).toBe("実行中 2・待ち 1");
  });

  test("adds a lower bound to the waiting count of a cut queue", () => {
    expect(
      overviewWords(
        state({
          overlay: {
            activity: activity({
              "flow:pipeline": { running: 1, queued: 3, runningJobId: ID },
            }),
            lowerBound: true,
          },
        }),
      ),
    ).toBe("実行中 1・待ち 3以上");
  });

  test("does not say that nothing runs when the queue was cut", () => {
    expect(
      overviewWords(
        state({ overlay: { activity: new Map(), lowerBound: true } }),
      ),
    ).not.toBe("いま動いているflowはありません");
  });

  test("says nothing when the read failed, since the note says so", () => {
    expect(
      overviewWords(state({ overlay: null, activeFailed: true })),
    ).toBeNull();
  });

  test("says nothing when nothing was asked for", () => {
    expect(overviewWords(state({ overlay: null }))).toBeNull();
  });
});

describe("the notes of a read that failed or was cut", () => {
  test("tells that the state of the runs could not be read", () => {
    expect(ACTIVE_READ_FAILED_NOTE).toBe("実行の状態を読めませんでした");
  });

  test("tells that the last results of the schedules could not be read", () => {
    expect(SCHEDULE_READ_FAILED_NOTE).toBe(
      "定期の入口の直近の結果を読めませんでした",
    );
  });

  test("tells that a flow without a mark may still run when the queue was cut", () => {
    expect(QUEUE_TRUNCATED_NOTE).toBe(
      "キューが切れているため、強調の無いflowも動いている場合があります",
    );
  });

  test("tells that a schedule entry without a note may exist when the schedules were cut", () => {
    expect(SCHEDULE_TRUNCATED_NOTE).toBe(
      "scheduleを読み切れていないため、添え書きの無い定期の入口があります",
    );
  });
});
