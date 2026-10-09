import { describe, expect, test } from "bun:test";
import { noticeSeverity } from "../../f/factory/lib/console_support.ts";
import {
  CONSOLE_WORKER_MISSING_NOTICE,
  CONSOLE_WORKER_PING_SECONDS,
  checkConsoleWorker,
  hasConsoleWorker,
} from "../../f/factory/lib/console_worker.ts";
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

  test("is false when the response is not an array", () => {
    expect(hasConsoleWorker({ workers: [CONSOLE_WORKER] })).toBe(false);
  });
});

describe("console_worker_missing notice", () => {
  test("is an action notice", () => {
    expect(noticeSeverity(CONSOLE_WORKER_MISSING_NOTICE.kind)).toBe("action");
  });

  test("uses the console_worker_missing kind", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.kind).toBe("console_worker_missing");
  });

  test("tells the operator what to check", () => {
    expect(CONSOLE_WORKER_MISSING_NOTICE.message).toContain(
      "windmill_worker_console",
    );
  });
});

type Harness = {
  readonly deps: Parameters<typeof checkConsoleWorker>[0];
  readonly notices: NoticeRecord[];
  readonly pages: { page: number; pingSince: number }[];
};

function harness(options: {
  readonly pages: readonly (unknown | Error)[];
  readonly addNoticeThrows?: boolean;
}): Harness {
  const notices: NoticeRecord[] = [];
  const pages: { page: number; pingSince: number }[] = [];
  return {
    notices,
    pages,
    deps: {
      listWorkers: async (page, pingSince) => {
        pages.push({ page, pingSince });
        const result = options.pages[page - 1] ?? [];
        if (result instanceof Error) throw result;
        return result;
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

describe("checkConsoleWorker", () => {
  test("adds no notice when a console worker pinged", async () => {
    const h = harness({ pages: [[CONSOLE_WORKER]] });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("returns present when a console worker pinged", async () => {
    const h = harness({ pages: [[CONSOLE_WORKER]] });
    expect(await checkConsoleWorker(h.deps)).toBe("present");
  });

  test("adds the notice when no console worker pinged", async () => {
    const h = harness({ pages: [[DEFAULT_WORKER]] });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([CONSOLE_WORKER_MISSING_NOTICE]);
  });

  test("returns missing when no console worker pinged", async () => {
    const h = harness({ pages: [[DEFAULT_WORKER]] });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });

  test("asks only for workers that pinged recently", async () => {
    const h = harness({ pages: [[CONSOLE_WORKER]] });
    await checkConsoleWorker(h.deps);
    expect(h.pages).toEqual([
      { page: 1, pingSince: CONSOLE_WORKER_PING_SECONDS },
    ]);
  });

  test("reads the next page when a page is full", async () => {
    const full = Array.from({ length: 100 }, () => DEFAULT_WORKER);
    const h = harness({ pages: [full, [CONSOLE_WORKER]] });
    expect(await checkConsoleWorker(h.deps)).toBe("present");
  });

  test("stops reading pages once a console worker is found", async () => {
    const full = Array.from({ length: 100 }, () => CONSOLE_WORKER);
    const h = harness({ pages: [full, [DEFAULT_WORKER]] });
    await checkConsoleWorker(h.deps);
    expect(h.pages.length).toBe(1);
  });

  test("does not throw when the worker list cannot be read", async () => {
    const h = harness({ pages: [new Error("forbidden")] });
    expect(await checkConsoleWorker(h.deps)).toBe("unknown");
  });

  test("adds no notice when the worker list cannot be read", async () => {
    const h = harness({ pages: [new Error("forbidden")] });
    await checkConsoleWorker(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({ pages: [[DEFAULT_WORKER]], addNoticeThrows: true });
    expect(await checkConsoleWorker(h.deps)).toBe("missing");
  });
});
