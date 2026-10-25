import { describe, expect, test } from "bun:test";
import {
  createPrefetchScheduler,
  handlePress,
  isPrimaryPress,
  PREFETCH_COOLDOWN_MS,
  type PressEvent,
} from "./prefetchSchedule.ts";

function setup() {
  const ran: string[] = [];
  const clock = { now: 1_000_000 };
  const scheduler = createPrefetchScheduler<string>({
    cooldownMs: PREFETCH_COOLDOWN_MS,
    now: () => clock.now,
    run: (key) => {
      ran.push(key);
    },
  });
  return { scheduler, ran, clock };
}

describe("createPrefetchScheduler runNow", () => {
  test("runs without waiting", () => {
    const { scheduler, ran } = setup();
    scheduler.runNow("system");
    expect(ran).toEqual(["system"]);
  });

  test("ignores an entrance that has just run", () => {
    const { scheduler, ran } = setup();
    scheduler.runNow("system");
    scheduler.runNow("system");
    expect(ran).toEqual(["system"]);
  });

  test("ignores the entrance until just before the cooldown ends", () => {
    const { scheduler, ran, clock } = setup();
    scheduler.runNow("system");
    clock.now += PREFETCH_COOLDOWN_MS - 1;
    scheduler.runNow("system");
    expect(ran).toEqual(["system"]);
  });

  test("accepts the entrance again after the cooldown", () => {
    const { scheduler, ran, clock } = setup();
    scheduler.runNow("system");
    clock.now += PREFETCH_COOLDOWN_MS;
    scheduler.runNow("system");
    expect(ran).toEqual(["system", "system"]);
  });

  test("still accepts another entrance during the cooldown", () => {
    const { scheduler, ran } = setup();
    scheduler.runNow("system");
    scheduler.runNow("items");
    expect(ran).toEqual(["system", "items"]);
  });
});

const PRIMARY_PRESS: PressEvent = {
  pointerType: "mouse",
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
};

describe("isPrimaryPress", () => {
  test("accepts a primary press without modifiers", () => {
    expect(isPrimaryPress(PRIMARY_PRESS)).toBe(true);
  });

  test("accepts a pen press", () => {
    expect(isPrimaryPress({ ...PRIMARY_PRESS, pointerType: "pen" })).toBe(true);
  });

  test("rejects a touch press, which may be the start of a scroll", () => {
    expect(isPrimaryPress({ ...PRIMARY_PRESS, pointerType: "touch" })).toBe(
      false,
    );
  });

  test("rejects a middle click", () => {
    expect(isPrimaryPress({ ...PRIMARY_PRESS, button: 1 })).toBe(false);
  });

  test("rejects a right click", () => {
    expect(isPrimaryPress({ ...PRIMARY_PRESS, button: 2 })).toBe(false);
  });

  test.each(["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)(
    "rejects a press with %s",
    (modifier) => {
      expect(isPrimaryPress({ ...PRIMARY_PRESS, [modifier]: true })).toBe(
        false,
      );
    },
  );
});

describe("handlePress", () => {
  test("prefetches at once on a primary press", () => {
    const calls: string[] = [];
    handlePress({ runNow: (key) => calls.push(key) }, "system", PRIMARY_PRESS);
    expect(calls).toEqual(["system"]);
  });

  test("does nothing for a press with a modifier", () => {
    const calls: string[] = [];
    handlePress({ runNow: (key) => calls.push(key) }, "system", {
      ...PRIMARY_PRESS,
      ctrlKey: true,
    });
    expect(calls).toEqual([]);
  });

  test("does nothing for a middle click", () => {
    const calls: string[] = [];
    handlePress({ runNow: (key) => calls.push(key) }, "system", {
      ...PRIMARY_PRESS,
      button: 1,
    });
    expect(calls).toEqual([]);
  });
});
