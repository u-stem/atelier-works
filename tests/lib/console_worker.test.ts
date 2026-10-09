import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  CONSOLE_WORKER_MISSING_NOTICE,
  checkConsoleWorker,
  parseConsoleWorkerExists,
} from "../../f/factory/lib/console_worker.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

describe("parseConsoleWorkerExists", () => {
  test("is true when the console tag has a worker", () => {
    expect(parseConsoleWorkerExists({ console: true })).toBe(true);
  });

  test("is false when the console tag has no worker", () => {
    expect(parseConsoleWorkerExists({ console: false })).toBe(false);
  });

  test("is null when the console tag is missing from the map", () => {
    expect(parseConsoleWorkerExists({ other: true })).toBeNull();
  });

  test("is null when the value is not a boolean", () => {
    expect(parseConsoleWorkerExists({ console: "yes" })).toBeNull();
  });

  test("is null for an array", () => {
    expect(parseConsoleWorkerExists([true])).toBeNull();
  });

  test("is null for null", () => {
    expect(parseConsoleWorkerExists(null)).toBeNull();
  });

  test("ignores other tags in the map", () => {
    expect(parseConsoleWorkerExists({ default: true, console: false })).toBe(
      false,
    );
  });
});

describe("console_worker_missing notice", () => {
  test("is an action notice", () => {
    expect(noticeSeverity(CONSOLE_WORKER_MISSING_NOTICE.kind)).toBe("action");
  });

  test("uses the console_worker_missing kind", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.kind).toBe("console_worker_missing");
  });

  test("tells the operator to start the container again", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain("mise run up");
  });

  test("tells the operator how to check the container", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain(
      "docker compose ps windmill_worker_console",
    );
  });
});

type Harness = {
  readonly deps: Parameters<typeof checkConsoleWorker>[0];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly tags: string[];
};

function harness(options: {
  readonly response: () => Promise<unknown>;
  readonly noticeInserted?: boolean;
  readonly addNoticeThrows?: boolean;
  readonly notifyThrows?: boolean;
  readonly timeoutMs?: number;
}): Harness {
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const tags: string[] = [];
  return {
    notices,
    events,
    tags,
    deps: {
      existsWorker: async (tag) => {
        tags.push(tag);
        return options.response();
      },
      addNotice: async (record) => {
        if (options.addNoticeThrows === true) throw new Error("db down");
        notices.push(record);
        return options.noticeInserted === false ? null : 1;
      },
      notify: async (event) => {
        if (options.notifyThrows === true) throw new Error("discord down");
        events.push(event);
      },
      instanceName: "local",
      log: logger("test", { sink: () => undefined }),
      timeoutMs: options.timeoutMs ?? 1000,
    },
  };
}

const PRESENT = async () => ({ console: true });
const ABSENT = async () => ({ console: false });

describe("checkConsoleWorker", () => {
  test("asks about the console tag only", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.tags).toEqual(["console"]);
  });

  test("returns present when a console worker exists", async () => {
    const h = harness({ response: PRESENT });
    expect(await checkConsoleWorker(h.deps)).toBe("present");
  });

  test("adds no notice when a console worker exists", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("adds the notice when no console worker exists", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("returns missing when no console worker exists", async () => {
    const h = harness({ response: ABSENT });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("sends Discord when the notice was newly inserted", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(h.events).toEqual([
      {
        kind: "console_worker_missing",
        instance_name: "local",
        cause: expect.stringContaining("console"),
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

  test("does not send Discord when a worker exists", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not throw when Discord cannot be reached", async () => {
    const h = harness({ response: ABSENT, notifyThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ response: ABSENT, addNoticeThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("returns unknown when the API call fails", async () => {
    const h = harness({
      response: async () => {
        throw new Error("forbidden");
      },
    });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when the API call fails", async () => {
    const h = harness({
      response: async () => {
        throw new Error("forbidden");
      },
    });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns unknown for a response of the wrong shape", async () => {
    const h = harness({ response: async () => ({ other: true }) });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
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
