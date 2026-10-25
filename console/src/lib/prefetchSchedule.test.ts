import { describe, expect, test } from "bun:test";
import {
  createPrefetchScheduler,
  PREFETCH_DELAY_MS,
} from "./prefetchSchedule.ts";

function setup() {
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  const ran: string[] = [];
  let nextHandle = 1;
  const scheduler = createPrefetchScheduler<string>({
    delayMs: PREFETCH_DELAY_MS,
    run: (key) => {
      ran.push(key);
    },
    timers: {
      set: (callback, ms) => {
        const handle = nextHandle;
        nextHandle += 1;
        delays.push(ms);
        timers.set(handle, callback);
        return handle;
      },
      clear: (handle) => {
        if (typeof handle === "number") {
          timers.delete(handle);
        }
      },
    },
  });
  return {
    scheduler,
    delays,
    ran,
    pending: () => timers.size,
    fireAll: () => {
      for (const [handle, callback] of [...timers]) {
        timers.delete(handle);
        callback();
      }
    },
  };
}

describe("PREFETCH_DELAY_MS", () => {
  test("is 100ms", () => {
    expect(PREFETCH_DELAY_MS).toBe(100);
  });
});

describe("createPrefetchScheduler", () => {
  test("does not run right away", () => {
    const { scheduler, ran } = setup();
    scheduler.request("system");
    expect(ran).toEqual([]);
  });

  test("waits for the delay", () => {
    const { scheduler, delays } = setup();
    scheduler.request("system");
    expect(delays).toEqual([100]);
  });

  test("runs after the delay", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });

  test("does not queue the same entrance twice while waiting", () => {
    const { scheduler, pending } = setup();
    scheduler.request("system");
    scheduler.request("system");
    expect(pending()).toBe(1);
  });

  test("runs the same entrance once for focus and pointerdown together", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });

  test("queues different entrances separately", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.request("items");
    fireAll();
    expect(ran).toEqual(["system", "items"]);
  });

  test("accepts a new request after the previous one has run", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    fireAll();
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system", "system"]);
  });

  test("does not run after cancelAll", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.cancelAll();
    fireAll();
    expect(ran).toEqual([]);
  });

  test("accepts a request after cancelAll", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.cancelAll();
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });
});
