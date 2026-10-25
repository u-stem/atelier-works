import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELAYED_OPTIONS,
  type DelayedEvent,
  type DelayedState,
  initialDelayedState,
  isDelayedVisible,
  NO_LINGER_OPTIONS,
  nextDelayedWake,
  reduceDelayed,
  scheduleDelayedWake,
} from "./delayedVisible.ts";

const OPTIONS = { delayMs: 300, minMs: 200 };

function run(
  initial: DelayedState,
  events: readonly DelayedEvent[],
): DelayedState {
  return events.reduce(
    (state, event) => reduceDelayed(state, event, OPTIONS),
    initial,
  );
}

const PENDING_AT_1000 = initialDelayedState(true, 1000);

describe("DEFAULT_DELAYED_OPTIONS", () => {
  test("waits 300ms before showing", () => {
    expect(DEFAULT_DELAYED_OPTIONS.delayMs).toBe(300);
  });

  test("keeps the skeleton for at least 200ms", () => {
    expect(DEFAULT_DELAYED_OPTIONS.minMs).toBe(200);
  });
});

describe("initialDelayedState", () => {
  test("starts hidden when not active", () => {
    expect(initialDelayedState(false, 1000)).toEqual({ phase: "hidden" });
  });

  test("starts pending from the mount time when active", () => {
    expect(initialDelayedState(true, 1000)).toEqual({
      phase: "pending",
      since: 1000,
    });
  });

  test("is not visible right after mounting while active", () => {
    expect(isDelayedVisible(initialDelayedState(true, 1000))).toBe(false);
  });
});

describe("reduceDelayed", () => {
  test("stays hidden before the delay has passed", () => {
    const state = run(PENDING_AT_1000, [{ type: "tick", at: 1299 }]);
    expect(isDelayedVisible(state)).toBe(false);
  });

  test("shows once the delay has passed", () => {
    const state = run(PENDING_AT_1000, [{ type: "tick", at: 1300 }]);
    expect(isDelayedVisible(state)).toBe(true);
  });

  test("never shows when the work ends within the delay", () => {
    const state = run(PENDING_AT_1000, [
      { type: "deactivate", at: 1200 },
      { type: "tick", at: 1300 },
    ]);
    expect(isDelayedVisible(state)).toBe(false);
  });

  test("goes back to hidden when the work ends within the delay", () => {
    const state = run(PENDING_AT_1000, [{ type: "deactivate", at: 1200 }]);
    expect(state).toEqual({ phase: "hidden" });
  });

  test("keeps showing for the minimum time after the work ends", () => {
    const state = run(PENDING_AT_1000, [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1350 },
    ]);
    expect(isDelayedVisible(state)).toBe(true);
  });

  test("hides once the minimum time has passed", () => {
    const state = run(PENDING_AT_1000, [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1350 },
      { type: "tick", at: 1500 },
    ]);
    expect(isDelayedVisible(state)).toBe(false);
  });

  test("does not hide a moment before the minimum time", () => {
    const state = run(PENDING_AT_1000, [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1350 },
      { type: "tick", at: 1499 },
    ]);
    expect(isDelayedVisible(state)).toBe(true);
  });

  test("hides at once when the minimum time has already passed", () => {
    const state = run(PENDING_AT_1000, [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1600 },
    ]);
    expect(isDelayedVisible(state)).toBe(false);
  });

  test("keeps the original shown time when the work restarts while lingering", () => {
    const state = run(PENDING_AT_1000, [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1350 },
      { type: "activate", at: 1400 },
      { type: "deactivate", at: 1550 },
    ]);
    expect(isDelayedVisible(state)).toBe(false);
  });

  test("does not restart the delay when activated twice", () => {
    const state = run(PENDING_AT_1000, [
      { type: "activate", at: 1200 },
      { type: "tick", at: 1300 },
    ]);
    expect(isDelayedVisible(state)).toBe(true);
  });

  test("starts the delay when activated from hidden", () => {
    const state = run({ phase: "hidden" }, [{ type: "activate", at: 5000 }]);
    expect(state).toEqual({ phase: "pending", since: 5000 });
  });
});

describe("nextDelayedWake", () => {
  test("wakes when the delay ends while pending", () => {
    expect(nextDelayedWake(PENDING_AT_1000, OPTIONS)).toBe(1300);
  });

  test("wakes when the minimum time ends while lingering", () => {
    expect(
      nextDelayedWake({ phase: "lingering", shownAt: 1300 }, OPTIONS),
    ).toBe(1500);
  });

  test("does not wake while hidden", () => {
    expect(nextDelayedWake({ phase: "hidden" }, OPTIONS)).toBeNull();
  });

  test("does not wake while shown", () => {
    expect(
      nextDelayedWake({ phase: "shown", shownAt: 1300 }, OPTIONS),
    ).toBeNull();
  });
});

function timerEnv(startAt: number) {
  const clock = { now: startAt };
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const events: DelayedEvent[] = [];
  let nextHandle = 1;
  return {
    clock,
    timers,
    events,
    env: {
      now: () => clock.now,
      setTimer: (callback: () => void, ms: number) => {
        const handle = nextHandle;
        nextHandle += 1;
        timers.set(handle, { callback, ms });
        return handle;
      },
      clearTimer: (handle: unknown) => {
        if (typeof handle === "number") {
          timers.delete(handle);
        }
      },
      dispatch: (event: DelayedEvent) => {
        events.push(event);
      },
    },
    fire: () => {
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

describe("scheduleDelayedWake", () => {
  test("sets no timer while hidden", () => {
    const { env, timers } = timerEnv(1000);
    scheduleDelayedWake({ phase: "hidden" }, OPTIONS, env);
    expect(timers.size).toBe(0);
  });

  test("waits for the rest of the delay while pending", () => {
    const { env, timers } = timerEnv(1100);
    scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([200]);
  });

  test("does not wait when the delay has already passed", () => {
    const { env, timers } = timerEnv(1500);
    scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([0]);
  });

  test("sends a tick at the wake time when the timer fires", () => {
    const { env, fire, events } = timerEnv(1000);
    scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    fire();
    expect(events).toEqual([{ type: "tick", at: 1300 }]);
  });

  test("sends a tick that is not early even if the clock is behind", () => {
    const { env, fire, events, clock } = timerEnv(1000);
    scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    clock.now = 1298;
    fire();
    expect(events).toEqual([{ type: "tick", at: 1300 }]);
  });

  test("sends the later time when the clock is ahead", () => {
    const { env, fire, events, clock } = timerEnv(1000);
    scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    clock.now = 1320;
    fire();
    expect(events).toEqual([{ type: "tick", at: 1320 }]);
  });

  test("waits for the minimum time while lingering", () => {
    const { env, timers } = timerEnv(1350);
    scheduleDelayedWake({ phase: "lingering", shownAt: 1300 }, OPTIONS, env);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([150]);
  });

  test("clears the timer on cleanup", () => {
    const { env, timers } = timerEnv(1000);
    const cleanup = scheduleDelayedWake(PENDING_AT_1000, OPTIONS, env);
    cleanup();
    expect(timers.size).toBe(0);
  });

  test("tolerates a cleanup without a timer", () => {
    const { env } = timerEnv(1000);
    const cleanup = scheduleDelayedWake({ phase: "hidden" }, OPTIONS, env);
    expect(() => cleanup()).not.toThrow();
  });
});

describe("NO_LINGER_OPTIONS", () => {
  test("keeps the delay before showing", () => {
    expect(NO_LINGER_OPTIONS.delayMs).toBe(300);
  });

  test("has no minimum time, so an approval panel shows the content as soon as it arrives", () => {
    expect(NO_LINGER_OPTIONS.minMs).toBe(0);
  });

  test("hides at once when the fetch ends right after the skeleton appeared", () => {
    const events: DelayedEvent[] = [
      { type: "tick", at: 1300 },
      { type: "deactivate", at: 1301 },
    ];
    const state = events.reduce<DelayedState>(
      (current, event) => reduceDelayed(current, event, NO_LINGER_OPTIONS),
      PENDING_AT_1000,
    );
    expect(isDelayedVisible(state)).toBe(false);
  });
});
