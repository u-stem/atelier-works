import { describe, expect, test } from "bun:test";
import { createIdleTracker } from "./idleTracker.ts";

/** 時間を手で進めるタイマー。 */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number): number => {
      const handle = next;
      next += 1;
      pending.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      if (typeof handle === "number") pending.delete(handle);
    },
    advance: (ms: number): void => {
      now += ms;
      for (const [handle, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(handle);
          timer.run();
        }
      }
    },
  };
}

function setup() {
  const timers = fakeTimers();
  const changes: boolean[] = [];
  const tracker = createIdleTracker({
    idleMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onChange: (idle) => changes.push(idle),
  });
  return { timers, changes, tracker };
}

describe("createIdleTracker", () => {
  test("reports idle once the time has passed without a touch", () => {
    const { timers, changes } = setup();
    timers.advance(1000);
    expect(changes).toEqual([true]);
  });

  test("stays quiet before the time has passed", () => {
    const { timers, changes } = setup();
    timers.advance(999);
    expect(changes).toEqual([]);
  });

  test("restarts the time on a touch", () => {
    const { timers, changes, tracker } = setup();
    timers.advance(600);
    tracker.touch();
    timers.advance(600);
    expect(changes).toEqual([]);
  });

  test("reports the return after an idle period", () => {
    const { timers, changes, tracker } = setup();
    timers.advance(1000);
    tracker.touch();
    expect(changes).toEqual([true, false]);
  });

  test("does not report a return for a touch while active", () => {
    const { changes, tracker } = setup();
    tracker.touch();
    expect(changes).toEqual([]);
  });

  test("goes idle again after the return", () => {
    const { timers, changes, tracker } = setup();
    timers.advance(1000);
    tracker.touch();
    timers.advance(1000);
    expect(changes).toEqual([true, false, true]);
  });

  test("stops the timer on dispose", () => {
    const { timers, changes, tracker } = setup();
    tracker.dispose();
    timers.advance(5000);
    expect(changes).toEqual([]);
  });
});
