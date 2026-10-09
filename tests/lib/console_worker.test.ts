import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  CONSOLE_JOB_WAIT_SECONDS,
  CONSOLE_WORKER_CHECK_FAILED_NOTICE,
  CONSOLE_WORKER_MISSING_NOTICE,
  CONSOLE_WORKER_UNKNOWN_LIMIT,
  checkConsoleWorker,
  judgeConsoleQueue,
  nextUnknownCount,
  parseUnknownCount,
  watchConsoleWorker,
} from "../../f/factory/lib/console_worker.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

/** 予定時刻から`seconds`秒前に予定され、まだ実行されていないジョブ。 */
function waiting(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    id: "job",
    tag: "console",
    running: false,
    scheduled_for: new Date(NOW - seconds * 1000).toISOString(),
    ...extra,
  };
}

/** `secondsAgo`秒前に終わった`console_fetch_watch`の実行。 */
function completed(secondsAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id: "run",
    script_path: "f/factory/console_fetch_watch",
    success: true,
    completed_at: new Date(NOW - secondsAgo * 1000).toISOString(),
    ...extra,
  };
}

const RECENT = [completed(600)];

describe("judgeConsoleQueue", () => {
  test("is ok when the only waiting job was scheduled under five minutes ago", () => {
    expect(judgeConsoleQueue([waiting(299)], RECENT, NOW)).toBe("ok");
  });

  test("is stalled when a job has waited five minutes", () => {
    expect(judgeConsoleQueue([waiting(300)], RECENT, NOW)).toBe("stalled");
  });

  test("is stalled when a job has waited over five minutes", () => {
    expect(judgeConsoleQueue([waiting(301)], RECENT, NOW)).toBe("stalled");
  });

  test("is stalled when one of several jobs has waited long enough", () => {
    expect(judgeConsoleQueue([waiting(10), waiting(900)], RECENT, NOW)).toBe(
      "stalled",
    );
  });

  test("is ok for an empty queue when a watch run completed recently", () => {
    expect(judgeConsoleQueue([], RECENT, NOW)).toBe("ok");
  });

  test("ignores a running job", () => {
    expect(
      judgeConsoleQueue([waiting(900, { running: true })], RECENT, NOW),
    ).toBe("ok");
  });

  test("ignores a job scheduled in the future", () => {
    expect(judgeConsoleQueue([waiting(-600)], RECENT, NOW)).toBe("ok");
  });

  test("does not count a job without scheduled_for", () => {
    expect(
      judgeConsoleQueue(
        [waiting(900, { scheduled_for: undefined })],
        RECENT,
        NOW,
      ),
    ).toBe("ok");
  });

  test("does not count a job whose scheduled_for is not a string", () => {
    expect(
      judgeConsoleQueue([waiting(900, { scheduled_for: 123 })], RECENT, NOW),
    ).toBe("ok");
  });

  test("does not count a job whose scheduled_for is not a date", () => {
    expect(
      judgeConsoleQueue([waiting(900, { scheduled_for: "soon" })], RECENT, NOW),
    ).toBe("ok");
  });

  test("skips malformed entries and still finds a stalled job", () => {
    expect(judgeConsoleQueue([null, 5, "x", waiting(900)], RECENT, NOW)).toBe(
      "stalled",
    );
  });

  test("is unknown for an object queue response", () => {
    expect(judgeConsoleQueue({ jobs: [] }, RECENT, NOW)).toBe("unknown");
  });

  test("is unknown for a null queue response", () => {
    expect(judgeConsoleQueue(null, RECENT, NOW)).toBe("unknown");
  });

  test("is ok when the latest watch run completed exactly thirty minutes ago", () => {
    expect(judgeConsoleQueue([], [completed(1800)], NOW)).toBe("ok");
  });

  test("is unknown when the latest watch run completed over thirty minutes ago", () => {
    expect(judgeConsoleQueue([], [completed(1801)], NOW)).toBe("unknown");
  });

  test("uses the newest completion among the watch runs", () => {
    expect(judgeConsoleQueue([], [completed(7200), completed(60)], NOW)).toBe(
      "ok",
    );
  });

  test("is unknown when there is no waiting job and no watch run", () => {
    expect(judgeConsoleQueue([], [], NOW)).toBe("unknown");
  });

  test("is unknown when the watch runs are not an array", () => {
    expect(judgeConsoleQueue([], { jobs: [] }, NOW)).toBe("unknown");
  });

  test("does not count a watch run without completed_at", () => {
    expect(
      judgeConsoleQueue([], [completed(60, { completed_at: undefined })], NOW),
    ).toBe("unknown");
  });

  test("does not count a watch run whose completed_at is not a date", () => {
    expect(
      judgeConsoleQueue([], [completed(60, { completed_at: "soon" })], NOW),
    ).toBe("unknown");
  });

  test("skips malformed watch runs and still finds a recent one", () => {
    expect(judgeConsoleQueue([], [null, 5, completed(60)], NOW)).toBe("ok");
  });

  test("is ok when a fresh job is waiting even without a watch run", () => {
    expect(judgeConsoleQueue([waiting(60)], [], NOW)).toBe("ok");
  });

  test("is stalled for a long wait even without a watch run", () => {
    expect(judgeConsoleQueue([waiting(900)], [], NOW)).toBe("stalled");
  });

  test("is stalled for a long wait even when the watch runs are not an array", () => {
    expect(judgeConsoleQueue([waiting(900)], null, NOW)).toBe("stalled");
  });

  test("uses a five minute threshold", () => {
    expect(CONSOLE_JOB_WAIT_SECONDS).toBe(300);
  });
});

describe("notices", () => {
  test("console_worker_missing is an action notice", () => {
    expect(noticeSeverity(CONSOLE_WORKER_MISSING_NOTICE.kind)).toBe("action");
  });

  test("console_worker_check_failed is an action notice", () => {
    expect(noticeSeverity(CONSOLE_WORKER_CHECK_FAILED_NOTICE.kind)).toBe(
      "action",
    );
  });

  test("the missing notice states the wait threshold from the constant", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain(
      `${CONSOLE_JOB_WAIT_SECONDS / 60}分以上`,
    );
  });

  test("the missing notice tells the operator to restart the container", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain(
      "docker compose restart windmill_worker_console",
    );
  });

  test("the missing notice tells the operator to check the running jobs", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain("実行中のジョブ");
  });

  test("the missing notice tells the operator to check the worker group tag", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain("ワーカーグループ");
  });

  test("the missing notice does not claim the worker is absent", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain("受けていません");
  });

  test("the check failed notice mentions the watch schedule", () => {
    expect(CONSOLE_WORKER_CHECK_FAILED_NOTICE.message).toContain(
      "console_fetch_watch",
    );
  });

  test("the missing notice tells the operator to start the container again", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain("mise run up");
  });

  test("the missing notice tells the operator how to check the container", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain(
      "docker compose ps windmill_worker_console",
    );
  });

  test("the check failed notice points at the self_update job log", () => {
    expect(CONSOLE_WORKER_CHECK_FAILED_NOTICE.message).toContain("self_update");
  });
});

describe("parseUnknownCount", () => {
  test("reads a stored count", () => {
    expect(parseUnknownCount({ console_worker_unknown_count: 3 })).toBe(3);
  });

  test("is zero for null", () => {
    expect(parseUnknownCount(null)).toBe(0);
  });

  test("is zero for an empty object", () => {
    expect(parseUnknownCount({})).toBe(0);
  });

  test("is zero for a negative count", () => {
    expect(parseUnknownCount({ console_worker_unknown_count: -1 })).toBe(0);
  });

  test("is zero for a non-integer count", () => {
    expect(parseUnknownCount({ console_worker_unknown_count: 1.5 })).toBe(0);
  });

  test("is zero for a string count", () => {
    expect(parseUnknownCount({ console_worker_unknown_count: "3" })).toBe(0);
  });
});

describe("nextUnknownCount", () => {
  test("adds one when the check was unknown", () => {
    expect(nextUnknownCount(2, "unknown")).toBe(3);
  });

  test("resets to zero when the queue is ok", () => {
    expect(nextUnknownCount(5, "ok")).toBe(0);
  });

  test("resets to zero when the queue is stalled", () => {
    expect(nextUnknownCount(5, "stalled")).toBe(0);
  });

  test("raises after six in a row", () => {
    expect(CONSOLE_WORKER_UNKNOWN_LIMIT).toBe(6);
  });
});

type Harness = {
  readonly deps: Parameters<typeof watchConsoleWorker>[0];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly states: unknown[];
  readonly logLines: string[];
};

function harness(options: {
  readonly response: () => Promise<unknown>;
  readonly recent?: () => Promise<unknown>;
  readonly storedCount?: number;
  readonly storedState?: unknown;
  readonly noticeInserted?: boolean;
  readonly addNoticeThrows?: boolean;
  readonly notifyThrows?: boolean;
  readonly getStateThrows?: boolean;
  readonly timeoutMs?: number;
}): Harness {
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const states: unknown[] = [];
  const logLines: string[] = [];
  return {
    logLines,
    notices,
    events,
    states,
    deps: {
      listWaitingJobs: async () => options.response(),
      listRecentWatchRuns: async () => (options.recent ?? RECENT_RUNS)(),
      now: () => NOW,
      addNotice: async (record) => {
        if (options.addNoticeThrows === true) throw new Error("db down");
        notices.push(record);
        return options.noticeInserted === false ? null : 1;
      },
      notify: async (event) => {
        if (options.notifyThrows === true) throw new Error("discord down");
        events.push(event);
      },
      getState: async () => {
        if (options.getStateThrows === true) throw new Error("state down");
        if (options.storedState !== undefined) return options.storedState;
        return options.storedCount === undefined
          ? null
          : { console_worker_unknown_count: options.storedCount };
      },
      setState: async (state) => {
        states.push(state);
      },
      instanceName: "local",
      log: logger("test", { sink: (line) => logLines.push(line) }),
      timeoutMs: options.timeoutMs ?? 1000,
    },
  };
}

const RECENT_RUNS = async () => RECENT;
const PRESENT = async () => [];
const ABSENT = async () => [waiting(600)];
const FAILS = async () => {
  throw new Error("forbidden");
};

describe("checkConsoleWorker", () => {
  test("returns ok when no job has waited long", async () => {
    const h = harness({ response: PRESENT });
    expect(await checkConsoleWorker(h.deps)).toBe("ok");
  });

  test("adds no notice when no job has waited long", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("adds the notice when a job has waited long", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("returns stalled when a job has waited long", async () => {
    const h = harness({ response: ABSENT });
    expect(await checkConsoleWorker(h.deps)).toBe("stalled");
  });

  test("sends Discord when the notice was newly inserted", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(h.events).toEqual([
      {
        kind: "console_worker_missing",
        instance_name: "local",
        cause: expect.stringContaining("Console"),
        next_action: expect.stringContaining("mise run up"),
      },
    ]);
  });

  test("names the container check in the Discord next action", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(JSON.stringify(h.events[0])).toContain(
      "docker compose ps windmill_worker_console",
    );
  });

  test("does not send Discord while the same notice is unresolved", async () => {
    const h = harness({ response: ABSENT, noticeInserted: false });
    await checkConsoleWorker(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not throw when Discord cannot be reached", async () => {
    const h = harness({ response: ABSENT, notifyThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("stalled");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ response: ABSENT, addNoticeThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("stalled");
  });

  test("returns unknown when listing the queue fails", async () => {
    const h = harness({ response: FAILS });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when listing the queue fails", async () => {
    const h = harness({ response: FAILS });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns unknown for a response that is not an array", async () => {
    const h = harness({ response: async () => ({ workers: [] }) });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("logs the listing failure", async () => {
    const h = harness({ response: FAILS });
    await checkConsoleWorker(h.deps);
    expect(h.logLines.join("\n")).toContain("could not list the console jobs");
  });

  test("logs the unconfirmed state for an unexpected response", async () => {
    const h = harness({ response: async () => ({ jobs: [] }) });
    await checkConsoleWorker(h.deps);
    expect(h.logLines.join("\n")).toContain(
      "could not confirm the console worker from the job lists",
    );
  });

  test("logs the timeout", async () => {
    const h = harness({
      response: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await checkConsoleWorker(h.deps);
    expect(h.logLines.join("\n")).toContain("console worker check timed out");
  });

  test("logs the listing failure of the watch runs", async () => {
    const h = harness({ response: PRESENT, recent: FAILS });
    await checkConsoleWorker(h.deps);
    expect(h.logLines.join("\n")).toContain("could not list the console jobs");
  });

  test("returns unknown when the watch runs cannot be listed", async () => {
    const h = harness({ response: PRESENT, recent: FAILS });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("returns unknown when nothing has run or waited recently", async () => {
    const h = harness({ response: PRESENT, recent: async () => [] });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("logs the unconfirmed state when nothing has run or waited recently", async () => {
    const h = harness({ response: PRESENT, recent: async () => [] });
    await checkConsoleWorker(h.deps);
    expect(h.logLines.join("\n")).toContain(
      "could not confirm the console worker from the job lists",
    );
  });

  test("still adds the notice when the watch runs cannot be listed but a job waits", async () => {
    const h = harness({ response: ABSENT, recent: FAILS });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("logs nothing when the queue is ok", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.logLines).toEqual([]);
  });

  test("returns unknown when the call hangs past the timeout", async () => {
    const h = harness({
      response: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when the call hangs past the timeout", async () => {
    const h = harness({
      response: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });
});

describe("watchConsoleWorker", () => {
  test("counts an unknown result", async () => {
    const h = harness({ response: FAILS, storedCount: 2 });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 3 }]);
  });

  test("does not raise before the limit", async () => {
    const h = harness({ response: FAILS, storedCount: 4 });
    await watchConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("raises the check failed notice on the sixth unknown in a row", async () => {
    const h = harness({ response: FAILS, storedCount: 5 });
    await watchConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_CHECK_FAILED_NOTICE]);
  });

  test("sends Discord when the check failed notice is newly inserted", async () => {
    const h = harness({ response: FAILS, storedCount: 5 });
    await watchConsoleWorker(h.deps);
    expect(h.events[0]).toMatchObject({
      kind: "console_worker_check_failed",
      instance_name: "local",
    });
  });

  test("does not send Discord while the check failed notice is unresolved", async () => {
    const h = harness({
      response: FAILS,
      storedCount: 7,
      noticeInserted: false,
    });
    await watchConsoleWorker(h.deps);
    expect(h.events).toEqual([]);
  });

  test("resets the count when the check succeeds", async () => {
    const h = harness({ response: PRESENT, storedCount: 4 });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 0 }]);
  });

  test("does not write the state when the count stays zero", async () => {
    const h = harness({ response: PRESENT });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([]);
  });

  test("resets the count when the queue is stalled", async () => {
    const h = harness({ response: ABSENT, storedCount: 3 });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 0 }]);
  });

  test("still sends the missing notice when the queue is stalled", async () => {
    const h = harness({ response: ABSENT });
    await watchConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("treats an unreadable state as a count of zero", async () => {
    const h = harness({ response: FAILS, getStateThrows: true });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 1 }]);
  });

  test("keeps the other keys of the stored state", async () => {
    const h = harness({
      response: FAILS,
      storedState: { other_key: "kept", console_worker_unknown_count: 2 },
    });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([
      { other_key: "kept", console_worker_unknown_count: 3 },
    ]);
  });

  test("keeps the other keys when the count resets", async () => {
    const h = harness({
      response: PRESENT,
      storedState: { other_key: "kept", console_worker_unknown_count: 2 },
    });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([
      { other_key: "kept", console_worker_unknown_count: 0 },
    ]);
  });

  test("adds the count to a state that has no count yet", async () => {
    const h = harness({ response: FAILS, storedState: { other_key: "kept" } });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([
      { other_key: "kept", console_worker_unknown_count: 1 },
    ]);
  });

  test("starts a fresh state when the stored state is not an object", async () => {
    const h = harness({ response: FAILS, storedState: "garbage" });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 1 }]);
  });

  test("returns the check result", async () => {
    const h = harness({ response: PRESENT });
    expect(await watchConsoleWorker(h.deps)).toBe("ok");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({
      response: FAILS,
      storedCount: 5,
      addNoticeThrows: true,
    });
    expect(await watchConsoleWorker(h.deps)).toBe("unknown");
  });
});
