import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  checkDefaultWorker,
  DEFAULT_WORKER_MISSING_NOTICE,
  DEFAULT_WORKER_WAIT_SECONDS,
  judgeDefaultQueue,
} from "../../f/factory/lib/default_worker.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

/** 予定時刻から`seconds`秒前に予定され、まだ実行されていないジョブ。 */
function waiting(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    id: "waiting-job",
    tag: "bun",
    job_kind: "script",
    running: false,
    scheduled_for: new Date(NOW - seconds * 1000).toISOString(),
    ...extra,
  };
}

/** 実行中のジョブ。 */
function running(extra: Record<string, unknown> = {}) {
  return {
    id: "running-job",
    tag: "bun",
    job_kind: "script",
    script_path: "f/factory/implement",
    running: true,
    scheduled_for: new Date(NOW - 3600 * 1000).toISOString(),
    ...extra,
  };
}

const LONG = DEFAULT_WORKER_WAIT_SECONDS;

describe("DEFAULT_WORKER_WAIT_SECONDS", () => {
  test("is ten minutes", () => {
    expect(DEFAULT_WORKER_WAIT_SECONDS).toBe(600);
  });
});

describe("judgeDefaultQueue", () => {
  test("is ok when nothing runs and nothing waits", () => {
    expect(judgeDefaultQueue([], [], NOW)).toBe("ok");
  });

  test("is ok when the longest wait is just under the threshold and nothing runs", () => {
    expect(judgeDefaultQueue([], [waiting(LONG - 1)], NOW)).toBe("ok");
  });

  test("is stalled when a default job has waited the threshold and nothing runs on default", () => {
    expect(judgeDefaultQueue([], [waiting(LONG)], NOW)).toBe("stalled");
  });

  test("is ok when a default job has waited long but a default job is running", () => {
    expect(judgeDefaultQueue([running()], [waiting(LONG * 10)], NOW)).toBe(
      "ok",
    );
  });

  test("is stalled when the only running jobs are on the periodic and console workers", () => {
    expect(
      judgeDefaultQueue(
        [running({ tag: "periodic" }), running({ tag: "console" })],
        [waiting(LONG)],
        NOW,
      ),
    ).toBe("stalled");
  });

  test("is stalled when the only running job is a flow parent", () => {
    expect(
      judgeDefaultQueue(
        [running({ tag: "flow", job_kind: "flow" })],
        [waiting(LONG)],
        NOW,
      ),
    ).toBe("stalled");
  });

  test("is ok when a flow parent and its step both run on default", () => {
    expect(
      judgeDefaultQueue(
        [running({ tag: "flow", job_kind: "flow" }), running()],
        [waiting(LONG)],
        NOW,
      ),
    ).toBe("ok");
  });

  test("ignores a long wait of a job on the periodic worker", () => {
    expect(
      judgeDefaultQueue([], [waiting(LONG, { tag: "periodic" })], NOW),
    ).toBe("ok");
  });

  test("ignores a long wait of a job on the console worker", () => {
    expect(
      judgeDefaultQueue([], [waiting(LONG, { tag: "console" })], NOW),
    ).toBe("ok");
  });

  test("ignores a long wait of a job on the native worker", () => {
    expect(
      judgeDefaultQueue([], [waiting(LONG, { tag: "postgresql" })], NOW),
    ).toBe("ok");
  });

  test("ignores a job scheduled in the future", () => {
    expect(judgeDefaultQueue([], [waiting(-60)], NOW)).toBe("ok");
  });

  test("ignores a suspended job", () => {
    expect(judgeDefaultQueue([], [waiting(LONG, { suspend: 1 })], NOW)).toBe(
      "ok",
    );
  });

  test("is stalled when one of several waiting jobs has waited long enough", () => {
    expect(judgeDefaultQueue([], [waiting(10), waiting(LONG)], NOW)).toBe(
      "stalled",
    );
  });

  test("is unknown when the waiting response is not an array", () => {
    expect(judgeDefaultQueue([], { jobs: [] }, NOW)).toBe("unknown");
  });

  test("is unknown when no waiting element can be read", () => {
    expect(judgeDefaultQueue([], [null, 5, "x"], NOW)).toBe("unknown");
  });

  test("is ok when the running response is unreadable but no job has waited long", () => {
    expect(judgeDefaultQueue({ jobs: [] }, [waiting(10)], NOW)).toBe("ok");
  });

  test("is unknown when a job has waited long and the running response is not an array", () => {
    expect(judgeDefaultQueue({ jobs: [] }, [waiting(LONG)], NOW)).toBe(
      "unknown",
    );
  });

  test("is unknown when a job has waited long and a running element cannot be read", () => {
    expect(judgeDefaultQueue([null], [waiting(LONG)], NOW)).toBe("unknown");
  });

  test("is unknown when a job has waited long and the only running job has an unknown tag", () => {
    expect(
      judgeDefaultQueue([running({ tag: "mystery" })], [waiting(LONG)], NOW),
    ).toBe("unknown");
  });

  test("is unknown when the running list is full of jobs that are not on default", () => {
    const full = Array.from({ length: 100 }, () =>
      running({ tag: "periodic" }),
    );
    expect(judgeDefaultQueue(full, [waiting(LONG)], NOW)).toBe("unknown");
  });

  test("is ok when the running list is full and one job runs on default", () => {
    const full = [
      ...Array.from({ length: 99 }, () => running({ tag: "periodic" })),
      running(),
    ];
    expect(judgeDefaultQueue(full, [waiting(LONG)], NOW)).toBe("ok");
  });
});

describe("the missing notice", () => {
  test("is an action notice", () => {
    expect(noticeSeverity(DEFAULT_WORKER_MISSING_NOTICE.kind)).toBe("action");
  });

  test("is of the default_worker_missing kind", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.kind).toBe("default_worker_missing");
  });

  test("states the wait threshold from the constant", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.message).toContain(
      `${DEFAULT_WORKER_WAIT_SECONDS / 60}分以上`,
    );
  });

  test("names the default worker as the target", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.message).toContain("defaultのworker");
  });

  test("tells the operator how to check the container", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.message).toContain(
      "docker compose ps windmill_worker",
    );
  });

  test("tells the operator to start the container with mise run up", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.message).toContain("mise run up");
  });

  test("tells the operator to look at the Workers screen of Windmill", () => {
    expect(DEFAULT_WORKER_MISSING_NOTICE.message).toContain("Workers");
  });
});

type Harness = {
  readonly deps: Parameters<typeof checkDefaultWorker>[0];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly resolved: { kind: string; prefix: string }[];
  readonly logLines: string[];
};

const IDLE = async () => [];
const STALLED = async () => [waiting(LONG)];
const FAILS = async () => {
  throw new Error("forbidden");
};

function harness(options: {
  readonly runningResponse?: () => Promise<unknown>;
  readonly waitingResponse: () => Promise<unknown>;
  readonly noticeInserted?: boolean;
  readonly addNoticeThrows?: boolean;
  readonly notifyThrows?: boolean;
  readonly resolveThrows?: boolean;
  readonly timeoutMs?: number;
}): Harness {
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const resolved: { kind: string; prefix: string }[] = [];
  const logLines: string[] = [];
  return {
    logLines,
    notices,
    events,
    resolved,
    deps: {
      listRunningJobs: async () => (options.runningResponse ?? IDLE)(),
      listWaitingJobs: async () => options.waitingResponse(),
      now: () => NOW,
      addNotice: async (record) => {
        if (options.addNoticeThrows === true) throw new Error("db down");
        notices.push(record);
        return options.noticeInserted === false ? null : 1;
      },
      resolveNotices: async (kind, prefix) => {
        if (options.resolveThrows === true) throw new Error("db down");
        resolved.push({ kind, prefix });
        return 1;
      },
      notify: async (event) => {
        if (options.notifyThrows === true) throw new Error("discord down");
        events.push(event);
      },
      instanceName: "local",
      log: logger("test", { sink: (line) => logLines.push(line) }),
      timeoutMs: options.timeoutMs ?? 1000,
    },
  };
}

describe("checkDefaultWorker", () => {
  test("returns ok when nothing waits", async () => {
    const h = harness({ waitingResponse: IDLE });
    expect(await checkDefaultWorker(h.deps)).toBe("ok");
  });

  test("adds no notice when nothing waits", async () => {
    const h = harness({ waitingResponse: IDLE });
    await checkDefaultWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns stalled when a job has waited long and nothing runs", async () => {
    const h = harness({ waitingResponse: STALLED });
    expect(await checkDefaultWorker(h.deps)).toBe("stalled");
  });

  test("adds the notice when a job has waited long and nothing runs", async () => {
    const h = harness({ waitingResponse: STALLED });
    await checkDefaultWorker(h.deps);
    expect(h.notices).toEqual([DEFAULT_WORKER_MISSING_NOTICE]);
  });

  test("adds no notice when a default job runs, however long the others wait", async () => {
    const h = harness({
      waitingResponse: STALLED,
      runningResponse: async () => [running()],
    });
    await checkDefaultWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("sends Discord with the cause and the next action when the notice was newly inserted", async () => {
    const h = harness({ waitingResponse: STALLED });
    await checkDefaultWorker(h.deps);
    expect(h.events).toEqual([
      {
        kind: "default_worker_missing",
        instance_name: "local",
        cause: expect.stringContaining("defaultのworker"),
        next_action: expect.stringContaining(
          "docker compose ps windmill_worker",
        ),
      },
    ]);
  });

  test("does not send Discord while the same notice is unresolved", async () => {
    const h = harness({ waitingResponse: STALLED, noticeInserted: false });
    await checkDefaultWorker(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not resolve the notice while the worker is stalled", async () => {
    const h = harness({ waitingResponse: STALLED });
    await checkDefaultWorker(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("resolves the notice when the wait has ended", async () => {
    const h = harness({ waitingResponse: IDLE });
    await checkDefaultWorker(h.deps);
    expect(h.resolved).toEqual([
      {
        kind: "default_worker_missing",
        prefix: DEFAULT_WORKER_MISSING_NOTICE.message,
      },
    ]);
  });

  test("resolves the notice when a default job runs again", async () => {
    const h = harness({
      waitingResponse: STALLED,
      runningResponse: async () => [running()],
    });
    await checkDefaultWorker(h.deps);
    expect(h.resolved).toHaveLength(1);
  });

  test("does not resolve the notice when the waiting jobs could not be listed", async () => {
    const h = harness({ waitingResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not resolve the notice when the running jobs could not be listed during a long wait", async () => {
    const h = harness({ waitingResponse: STALLED, runningResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("returns unknown when the running jobs could not be listed during a long wait", async () => {
    const h = harness({ waitingResponse: STALLED, runningResponse: FAILS });
    expect(await checkDefaultWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when the running jobs could not be listed during a long wait", async () => {
    const h = harness({ waitingResponse: STALLED, runningResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns ok when the running jobs could not be listed but nothing waits long", async () => {
    const h = harness({ waitingResponse: IDLE, runningResponse: FAILS });
    expect(await checkDefaultWorker(h.deps)).toBe("ok");
  });

  test("does not throw when Discord cannot be reached", async () => {
    const h = harness({ waitingResponse: STALLED, notifyThrows: true });
    expect(await checkDefaultWorker(h.deps)).toBe("stalled");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ waitingResponse: STALLED, addNoticeThrows: true });
    expect(await checkDefaultWorker(h.deps)).toBe("stalled");
  });

  test("does not throw when the notice cannot be resolved", async () => {
    const h = harness({ waitingResponse: IDLE, resolveThrows: true });
    expect(await checkDefaultWorker(h.deps)).toBe("ok");
  });

  test("returns unknown when listing the waiting jobs fails", async () => {
    const h = harness({ waitingResponse: FAILS });
    expect(await checkDefaultWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when listing the waiting jobs fails", async () => {
    const h = harness({ waitingResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns unknown for a waiting response that is not an array", async () => {
    const h = harness({ waitingResponse: async () => ({ jobs: [] }) });
    expect(await checkDefaultWorker(h.deps)).toBe("unknown");
  });

  test("logs the failure to list the waiting jobs", async () => {
    const h = harness({ waitingResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.logLines.join("\n")).toContain(
      "could not list the waiting default jobs",
    );
  });

  test("logs the failure to list the running jobs", async () => {
    const h = harness({ waitingResponse: IDLE, runningResponse: FAILS });
    await checkDefaultWorker(h.deps);
    expect(h.logLines.join("\n")).toContain(
      "could not list the running default jobs",
    );
  });

  test("returns unknown when the check does not finish in time", async () => {
    const h = harness({
      waitingResponse: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    expect(await checkDefaultWorker(h.deps)).toBe("unknown");
  });

  test("logs the timeout", async () => {
    const h = harness({
      waitingResponse: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await checkDefaultWorker(h.deps);
    expect(h.logLines.join("\n")).toContain("default worker check timed out");
  });
});
