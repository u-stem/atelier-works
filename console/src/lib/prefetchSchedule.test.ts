import { describe, expect, test } from "bun:test";
import {
  createPrefetchScheduler,
  handlePrefetchEvent,
  PREFETCH_COOLDOWN_MS,
  PREFETCH_DELAY_MS,
  type PrefetchEvent,
  type PrefetchScheduler,
  prefetchIntentOf,
} from "./prefetchSchedule.ts";

function setup() {
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  const ran: string[] = [];
  const clock = { now: 1_000_000 };
  let nextHandle = 1;
  const scheduler = createPrefetchScheduler<string>({
    delayMs: PREFETCH_DELAY_MS,
    cooldownMs: PREFETCH_COOLDOWN_MS,
    now: () => clock.now,
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
    clock,
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

describe("createPrefetchScheduler request", () => {
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

  test("queues different entrances separately", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.request("items");
    fireAll();
    expect(ran).toEqual(["system", "items"]);
  });

  test("accepts a new request after the cooldown has passed", () => {
    const { scheduler, ran, fireAll, clock } = setup();
    scheduler.request("system");
    fireAll();
    clock.now += PREFETCH_COOLDOWN_MS;
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system", "system"]);
  });

  test("ignores a request for the entrance that has just run", () => {
    const { scheduler, ran, fireAll, clock } = setup();
    scheduler.request("system");
    fireAll();
    clock.now += PREFETCH_COOLDOWN_MS - 1;
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });

  test("still accepts another entrance during the cooldown", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    fireAll();
    scheduler.request("items");
    fireAll();
    expect(ran).toEqual(["system", "items"]);
  });
});

describe("createPrefetchScheduler runNow", () => {
  test("runs without waiting", () => {
    const { scheduler, ran } = setup();
    scheduler.runNow("system");
    expect(ran).toEqual(["system"]);
  });

  test("takes over a request that is still waiting", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.runNow("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });

  test("ignores an entrance that has just run", () => {
    const { scheduler, ran } = setup();
    scheduler.runNow("system");
    scheduler.runNow("system");
    expect(ran).toEqual(["system"]);
  });

  test("ignores the focus that follows a press", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.runNow("system");
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });
});

describe("createPrefetchScheduler cancel", () => {
  test("drops the waiting request of the entrance", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.cancel("system");
    fireAll();
    expect(ran).toEqual([]);
  });

  test("keeps the waiting request of another entrance", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.request("items");
    scheduler.cancel("system");
    fireAll();
    expect(ran).toEqual(["items"]);
  });

  test("accepts a request after cancel", () => {
    const { scheduler, ran, fireAll } = setup();
    scheduler.request("system");
    scheduler.cancel("system");
    scheduler.request("system");
    fireAll();
    expect(ran).toEqual(["system"]);
  });

  test("does nothing for an entrance that is not waiting", () => {
    const { scheduler } = setup();
    expect(() => scheduler.cancel("system")).not.toThrow();
  });
});

describe("createPrefetchScheduler cancelAll", () => {
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

const PRIMARY_PRESS: PrefetchEvent = {
  type: "pointerdown",
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
};

describe("prefetchIntentOf", () => {
  test("waits after focus", () => {
    expect(prefetchIntentOf({ type: "focus" })).toBe("later");
  });

  test("cancels on blur", () => {
    expect(prefetchIntentOf({ type: "blur" })).toBe("cancel");
  });

  test("runs at once on a primary press", () => {
    expect(prefetchIntentOf(PRIMARY_PRESS)).toBe("now");
  });

  test("ignores a middle click", () => {
    expect(prefetchIntentOf({ ...PRIMARY_PRESS, button: 1 })).toBe("ignore");
  });

  test("ignores a right click", () => {
    expect(prefetchIntentOf({ ...PRIMARY_PRESS, button: 2 })).toBe("ignore");
  });

  test.each(["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)(
    "ignores a press with %s",
    (modifier) => {
      expect(prefetchIntentOf({ ...PRIMARY_PRESS, [modifier]: true })).toBe(
        "ignore",
      );
    },
  );
});

function recordingScheduler() {
  const calls: string[] = [];
  const scheduler: PrefetchScheduler<string> = {
    request: (key) => {
      calls.push(`request ${key}`);
    },
    runNow: (key) => {
      calls.push(`runNow ${key}`);
    },
    cancel: (key) => {
      calls.push(`cancel ${key}`);
    },
    cancelAll: () => {
      calls.push("cancelAll");
    },
  };
  return { scheduler, calls };
}

describe("handlePrefetchEvent", () => {
  test("requests a delayed prefetch on focus", () => {
    const { scheduler, calls } = recordingScheduler();
    handlePrefetchEvent(scheduler, "system", { type: "focus" });
    expect(calls).toEqual(["request system"]);
  });

  test("cancels the waiting prefetch on blur", () => {
    const { scheduler, calls } = recordingScheduler();
    handlePrefetchEvent(scheduler, "system", { type: "blur" });
    expect(calls).toEqual(["cancel system"]);
  });

  test("prefetches at once on a primary press", () => {
    const { scheduler, calls } = recordingScheduler();
    handlePrefetchEvent(scheduler, "system", PRIMARY_PRESS);
    expect(calls).toEqual(["runNow system"]);
  });

  test("does nothing for a press with a modifier", () => {
    const { scheduler, calls } = recordingScheduler();
    handlePrefetchEvent(scheduler, "system", {
      ...PRIMARY_PRESS,
      ctrlKey: true,
    });
    expect(calls).toEqual([]);
  });

  test("does nothing for a middle click", () => {
    const { scheduler, calls } = recordingScheduler();
    handlePrefetchEvent(scheduler, "system", { ...PRIMARY_PRESS, button: 1 });
    expect(calls).toEqual([]);
  });
});
