import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELAYED_OPTIONS,
  type DelayedEvent,
  type DelayedState,
  initialDelayedState,
  isDelayedVisible,
  nextDelayedWake,
  reduceDelayed,
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
