import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  CONSOLE_WORKER_CHECK_FAILED_NOTICE,
  CONSOLE_WORKER_MISSING_NOTICE,
  CONSOLE_WORKER_PING_SECONDS,
  CONSOLE_WORKER_UNKNOWN_LIMIT,
  checkConsoleWorker,
  hasConsoleWorker,
  nextUnknownCount,
  parseUnknownCount,
  watchConsoleWorker,
} from "../../f/factory/lib/console_worker.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const DEFAULT_WORKER = {
  worker: "w1",
  worker_group: "default",
  custom_tags: [],
};
const CONSOLE_WORKER = {
  worker: "w2",
  worker_group: "console",
  custom_tags: ["console"],
};

describe("hasConsoleWorker", () => {
  test("is true when a worker carries the console tag", () => {
    expect(hasConsoleWorker([DEFAULT_WORKER, CONSOLE_WORKER])).toBe(true);
  });

  test("is false when no worker carries the console tag", () => {
    expect(hasConsoleWorker([DEFAULT_WORKER])).toBe(false);
  });

  test("is false for an empty list", () => {
    expect(hasConsoleWorker([])).toBe(false);
  });

  test("is false when custom_tags is missing", () => {
    expect(hasConsoleWorker([{ worker: "w1" }])).toBe(false);
  });

  test("is false when custom_tags is not an array", () => {
    expect(hasConsoleWorker([{ custom_tags: "console" }])).toBe(false);
  });

  test("ignores a tag that only contains console", () => {
    expect(hasConsoleWorker([{ custom_tags: ["console2", "x-console"] }])).toBe(
      false,
    );
  });

  test("skips malformed entries and still finds a console worker", () => {
    expect(hasConsoleWorker([null, 5, "x", CONSOLE_WORKER])).toBe(true);
  });

  test("ignores non-string tags", () => {
    expect(hasConsoleWorker([{ custom_tags: [1, null] }])).toBe(false);
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

  test("resets to zero when a worker is present", () => {
    expect(nextUnknownCount(5, "present")).toBe(0);
  });

  test("resets to zero when the worker is confirmed missing", () => {
    expect(nextUnknownCount(5, "missing")).toBe(0);
  });

  test("raises after six in a row", () => {
    expect(CONSOLE_WORKER_UNKNOWN_LIMIT).toBe(6);
  });
});

type Harness = {
  readonly deps: Parameters<typeof watchConsoleWorker>[0];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly pings: number[];
  readonly states: unknown[];
};

function harness(options: {
  readonly response: () => Promise<unknown>;
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
  const pings: number[] = [];
  const states: unknown[] = [];
  return {
    notices,
    events,
    pings,
    states,
    deps: {
      listWorkers: async (pingSince) => {
        pings.push(pingSince);
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
      log: logger("test", { sink: () => undefined }),
      timeoutMs: options.timeoutMs ?? 1000,
    },
  };
}

const PRESENT = async () => [CONSOLE_WORKER];
const ABSENT = async () => [DEFAULT_WORKER];
const FAILS = async () => {
  throw new Error("forbidden");
};

describe("checkConsoleWorker", () => {
  test("asks for workers that pinged within the window", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.pings).toEqual([CONSOLE_WORKER_PING_SECONDS]);
  });

  test("uses a five minute window", () => {
    expect(CONSOLE_WORKER_PING_SECONDS).toBe(300);
  });

  test("returns present when a console worker is listed", async () => {
    const h = harness({ response: PRESENT });
    expect(await checkConsoleWorker(h.deps)).toBe("present");
  });

  test("adds no notice when a console worker is listed", async () => {
    const h = harness({ response: PRESENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("adds the notice when no console worker is listed", async () => {
    const h = harness({ response: ABSENT });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("returns missing when no console worker is listed", async () => {
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

  test("does not throw when Discord cannot be reached", async () => {
    const h = harness({ response: ABSENT, notifyThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ response: ABSENT, addNoticeThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("returns unknown when the API call fails", async () => {
    const h = harness({ response: FAILS });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when the API call fails", async () => {
    const h = harness({ response: FAILS });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns unknown for a response that is not a list", async () => {
    const h = harness({ response: async () => ({ workers: [] }) });
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

  test("resets the count when the worker is confirmed missing", async () => {
    const h = harness({ response: ABSENT, storedCount: 3 });
    await watchConsoleWorker(h.deps);
    expect(h.states).toEqual([{ console_worker_unknown_count: 0 }]);
  });

  test("still sends the missing notice when the worker is missing", async () => {
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
    expect(await watchConsoleWorker(h.deps)).toBe("present");
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
