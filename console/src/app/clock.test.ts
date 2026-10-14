import { describe, expect, test } from "bun:test";
import { createClock } from "./clock.ts";

function setup() {
  let nowMs = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  const clock = createClock({
    intervalMs: 30_000,
    now: () => nowMs,
    setTimer: (fn) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: (handle) => {
      cleared.push(handle);
      timers.delete(handle);
    },
  });
  const tick = (to: number): void => {
    nowMs = to;
    for (const fn of [...timers.values()]) {
      fn();
    }
  };
  return { clock, timers, cleared, tick };
}

describe("createClock", () => {
  test("starts no timer before anyone subscribes", () => {
    expect(setup().timers.size).toBe(0);
  });

  test("starts one timer for the first subscriber", () => {
    const { clock, timers } = setup();
    clock.subscribe(() => undefined);
    expect(timers.size).toBe(1);
  });

  test("shares one timer among subscribers", () => {
    const { clock, timers } = setup();
    clock.subscribe(() => undefined);
    clock.subscribe(() => undefined);
    expect(timers.size).toBe(1);
  });

  test("notifies every subscriber on a tick", () => {
    const { clock, tick } = setup();
    let calls = 0;
    clock.subscribe(() => {
      calls += 1;
    });
    clock.subscribe(() => {
      calls += 1;
    });
    tick(31_000);
    expect(calls).toBe(2);
  });

  test("updates the snapshot on a tick", () => {
    const { clock, tick } = setup();
    clock.subscribe(() => undefined);
    tick(31_000);
    expect(clock.getSnapshot()).toBe(31_000);
  });

  test("keeps the same snapshot between ticks", () => {
    const { clock } = setup();
    clock.subscribe(() => undefined);
    expect(clock.getSnapshot()).toBe(clock.getSnapshot());
  });

  test("keeps the timer while a subscriber remains", () => {
    const { clock, timers } = setup();
    const first = clock.subscribe(() => undefined);
    clock.subscribe(() => undefined);
    first();
    expect(timers.size).toBe(1);
  });

  test("stops the timer when the last subscriber leaves", () => {
    const { clock, timers } = setup();
    const first = clock.subscribe(() => undefined);
    const second = clock.subscribe(() => undefined);
    first();
    second();
    expect(timers.size).toBe(0);
  });

  test("restarts the timer for a later subscriber", () => {
    const { clock, timers } = setup();
    clock.subscribe(() => undefined)();
    clock.subscribe(() => undefined);
    expect(timers.size).toBe(1);
  });

  test("refreshes a stale snapshot when the first subscriber arrives", () => {
    const { clock, tick } = setup();
    const stop = clock.subscribe(() => undefined);
    tick(31_000);
    stop();
    tick(99_000);
    clock.subscribe(() => undefined);
    expect(clock.getSnapshot()).toBe(99_000);
  });

  test("ignores a second unsubscribe of the same subscriber", () => {
    const { clock, timers } = setup();
    const first = clock.subscribe(() => undefined);
    clock.subscribe(() => undefined);
    first();
    first();
    expect(timers.size).toBe(1);
  });
});
