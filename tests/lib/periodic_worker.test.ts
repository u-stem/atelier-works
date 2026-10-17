import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  checkPeriodicWorker,
  judgePeriodicQueue,
  PERIODIC_JOB_WAIT_SECONDS,
  PERIODIC_WORKER_MISSING_NOTICE,
  PERIODIC_WORKER_NOTICE_PREFIX,
  periodicQueueQuery,
} from "../../f/factory/lib/periodic_worker.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

/** 予定時刻から`seconds`秒前に予定され、まだ実行されていないジョブ。 */
function waiting(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    id: "job",
    tag: "periodic",
    running: false,
    scheduled_for: new Date(NOW - seconds * 1000).toISOString(),
    ...extra,
  };
}

describe("judgePeriodicQueue", () => {
  test("is ok for an empty queue", () => {
    expect(judgePeriodicQueue([], NOW)).toBe("ok");
  });

  test("is ok when the only waiting job was scheduled just under the threshold ago", () => {
    expect(
      judgePeriodicQueue([waiting(PERIODIC_JOB_WAIT_SECONDS - 1)], NOW),
    ).toBe("ok");
  });

  test("is stalled when a job has waited the threshold", () => {
    expect(judgePeriodicQueue([waiting(PERIODIC_JOB_WAIT_SECONDS)], NOW)).toBe(
      "stalled",
    );
  });

  test("is stalled when one of several jobs has waited long enough", () => {
    expect(
      judgePeriodicQueue(
        [waiting(10), waiting(PERIODIC_JOB_WAIT_SECONDS)],
        NOW,
      ),
    ).toBe("stalled");
  });

  test("ignores a running job", () => {
    expect(
      judgePeriodicQueue(
        [waiting(PERIODIC_JOB_WAIT_SECONDS, { running: true })],
        NOW,
      ),
    ).toBe("ok");
  });

  test("ignores a job with another tag", () => {
    expect(
      judgePeriodicQueue(
        [waiting(PERIODIC_JOB_WAIT_SECONDS, { tag: "bun" })],
        NOW,
      ),
    ).toBe("ok");
  });

  test("ignores a job with a console tag", () => {
    expect(
      judgePeriodicQueue(
        [waiting(PERIODIC_JOB_WAIT_SECONDS, { tag: "console" })],
        NOW,
      ),
    ).toBe("ok");
  });

  test("ignores a job scheduled in the future", () => {
    expect(judgePeriodicQueue([waiting(-60)], NOW)).toBe("ok");
  });

  test("ignores a job whose scheduled time cannot be read", () => {
    expect(
      judgePeriodicQueue(
        [waiting(PERIODIC_JOB_WAIT_SECONDS, { scheduled_for: "soon" })],
        NOW,
      ),
    ).toBe("ok");
  });

  test("ignores a job without a scheduled time", () => {
    expect(
      judgePeriodicQueue(
        [waiting(PERIODIC_JOB_WAIT_SECONDS, { scheduled_for: undefined })],
        NOW,
      ),
    ).toBe("ok");
  });

  test("skips malformed elements and still finds a long wait", () => {
    expect(
      judgePeriodicQueue(
        [null, 5, "x", waiting(PERIODIC_JOB_WAIT_SECONDS)],
        NOW,
      ),
    ).toBe("stalled");
  });

  test("is unknown for a response that is not an array", () => {
    expect(judgePeriodicQueue({ jobs: [] }, NOW)).toBe("unknown");
  });
});

describe("periodicQueueQuery", () => {
  test("asks for waiting periodic jobs oldest first", () => {
    expect(periodicQueueQuery("factory")).toEqual({
      workspace: "factory",
      tag: "periodic",
      running: false,
      scheduledForBeforeNow: true,
      orderDesc: false,
      perPage: 100,
    });
  });
});

describe("the wait threshold", () => {
  test("is 11 minutes, which covers the other scripts' timeouts and the margin", () => {
    expect(PERIODIC_JOB_WAIT_SECONDS).toBe(660);
  });
});

describe("the missing notice", () => {
  test("starts with the prefix that resolves it", () => {
    expect(
      PERIODIC_WORKER_MISSING_NOTICE.message.startsWith(
        PERIODIC_WORKER_NOTICE_PREFIX,
      ),
    ).toBe(true);
  });

  test("keeps the prefix free of the threshold", () => {
    expect(PERIODIC_WORKER_NOTICE_PREFIX).not.toMatch(/\d/);
  });

  test("is an action notice", () => {
    expect(noticeSeverity(PERIODIC_WORKER_MISSING_NOTICE.kind)).toBe("action");
  });

  test("is of the periodic_worker_missing kind", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.kind).toBe("periodic_worker_missing");
  });

  test("states the wait threshold from the constant", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.message).toContain(
      `${PERIODIC_JOB_WAIT_SECONDS / 60}分以上`,
    );
  });

  test("names the tag of the waiting jobs", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.message).toContain("tag periodic");
  });

  test("tells the operator how to check the container", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.message).toContain(
      "docker compose ps windmill_worker_periodic",
    );
  });

  test("tells the operator to start the container with mise run up", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.message).toContain("mise run up");
  });

  test("tells the operator to check the allowed custom tags", () => {
    expect(PERIODIC_WORKER_MISSING_NOTICE.message).toContain(
      "mise run instance:tags",
    );
  });
});

type Harness = {
  readonly deps: Parameters<typeof checkPeriodicWorker>[0];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly resolved: { kind: string; prefix: string }[];
  readonly logLines: string[];
};

function harness(options: {
  readonly response: () => Promise<unknown>;
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
      listWaitingJobs: async () => options.response(),
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

const IDLE = async () => [];
const STALLED = async () => [waiting(PERIODIC_JOB_WAIT_SECONDS)];
const FAILS = async () => {
  throw new Error("forbidden");
};

describe("checkPeriodicWorker", () => {
  test("returns ok when no job has waited long", async () => {
    const h = harness({ response: IDLE });
    expect(await checkPeriodicWorker(h.deps)).toBe("ok");
  });

  test("adds no notice when no job has waited long", async () => {
    const h = harness({ response: IDLE });
    await checkPeriodicWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns stalled when a job has waited long", async () => {
    const h = harness({ response: STALLED });
    expect(await checkPeriodicWorker(h.deps)).toBe("stalled");
  });

  test("adds the notice when a job has waited long", async () => {
    const h = harness({ response: STALLED });
    await checkPeriodicWorker(h.deps);
    expect(h.notices).toEqual([PERIODIC_WORKER_MISSING_NOTICE]);
  });

  test("sends Discord with the cause and the next action when the notice was newly inserted", async () => {
    const h = harness({ response: STALLED });
    await checkPeriodicWorker(h.deps);
    expect(h.events).toEqual([
      {
        kind: "periodic_worker_missing",
        instance_name: "local",
        cause: expect.stringContaining("tag periodic"),
        next_action: expect.stringContaining(
          "docker compose ps windmill_worker_periodic",
        ),
      },
    ]);
  });

  test("does not send Discord while the same notice is unresolved", async () => {
    const h = harness({ response: STALLED, noticeInserted: false });
    await checkPeriodicWorker(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not resolve the notice while a job is stalled", async () => {
    const h = harness({ response: STALLED });
    await checkPeriodicWorker(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("resolves the notice when no job waits long any more", async () => {
    const h = harness({ response: IDLE });
    await checkPeriodicWorker(h.deps);
    expect(h.resolved).toEqual([
      {
        kind: "periodic_worker_missing",
        prefix: PERIODIC_WORKER_NOTICE_PREFIX,
      },
    ]);
  });

  test("resolves a notice written with an older threshold", async () => {
    const h = harness({ response: IDLE });
    await checkPeriodicWorker(h.deps);
    const olderBody =
      "tag periodicのジョブが15分以上待たされています。定期ジョブ用のworkerが居ない";
    expect(olderBody.startsWith(h.resolved[0]?.prefix ?? "\0")).toBe(true);
  });

  test("does not resolve the notice when the queue could not be read", async () => {
    const h = harness({ response: FAILS });
    await checkPeriodicWorker(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not throw when Discord cannot be reached", async () => {
    const h = harness({ response: STALLED, notifyThrows: true });
    expect(await checkPeriodicWorker(h.deps)).toBe("stalled");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ response: STALLED, addNoticeThrows: true });
    expect(await checkPeriodicWorker(h.deps)).toBe("stalled");
  });

  test("does not throw when the notice cannot be resolved", async () => {
    const h = harness({ response: IDLE, resolveThrows: true });
    expect(await checkPeriodicWorker(h.deps)).toBe("ok");
  });

  test("returns unknown when listing the queue fails", async () => {
    const h = harness({ response: FAILS });
    expect(await checkPeriodicWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when listing the queue fails", async () => {
    const h = harness({ response: FAILS });
    await checkPeriodicWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns unknown for a response that is not an array", async () => {
    const h = harness({ response: async () => ({ jobs: [] }) });
    expect(await checkPeriodicWorker(h.deps)).toBe("unknown");
  });

  test("logs the failure to list the waiting jobs", async () => {
    const h = harness({ response: FAILS });
    await checkPeriodicWorker(h.deps);
    expect(h.logLines.join("\n")).toContain(
      "could not list the waiting periodic jobs",
    );
  });

  test("returns unknown when the check does not finish in time", async () => {
    const h = harness({
      response: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    expect(await checkPeriodicWorker(h.deps)).toBe("unknown");
  });

  test("logs the timeout", async () => {
    const h = harness({
      response: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await checkPeriodicWorker(h.deps);
    expect(h.logLines.join("\n")).toContain("periodic worker check timed out");
  });
});
