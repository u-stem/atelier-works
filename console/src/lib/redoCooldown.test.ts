import { describe, expect, test } from "bun:test";
import {
  createRedoCooldowns,
  REDO_COOLDOWN_MS,
  redoCooldownMessage,
  redoCooldownRemaining,
} from "./redoCooldown.ts";

describe("redoCooldownRemaining", () => {
  test("is zero for a request that was never redone", () => {
    expect(redoCooldownRemaining(undefined, 1_000)).toBe(0);
  });

  test("is the whole period right after the redo", () => {
    expect(redoCooldownRemaining(1_000, 1_000)).toBe(REDO_COOLDOWN_MS);
  });

  test("shrinks as time passes", () => {
    expect(redoCooldownRemaining(1_000, 61_000)).toBe(
      REDO_COOLDOWN_MS - 60_000,
    );
  });

  test("is zero once the period has passed", () => {
    expect(redoCooldownRemaining(1_000, 1_000 + REDO_COOLDOWN_MS)).toBe(0);
  });
});

describe("redoCooldownMessage", () => {
  test("says that the creation takes minutes and how long to wait", () => {
    expect(redoCooldownMessage(REDO_COOLDOWN_MS)).toBe(
      "起票に数分かかります。あと約15分は押せません。",
    );
  });

  test("rounds a partial minute up", () => {
    expect(redoCooldownMessage(61_000)).toBe(
      "起票に数分かかります。あと約2分は押せません。",
    );
  });
});

describe("createRedoCooldowns", () => {
  test("holds the cooldown of the request that was redone", () => {
    const cooldowns = createRedoCooldowns();
    cooldowns.start(7, 1_000);
    expect(cooldowns.remaining(7, 1_000)).toBe(REDO_COOLDOWN_MS);
  });

  test("does not hold the cooldown of another request", () => {
    const cooldowns = createRedoCooldowns();
    cooldowns.start(7, 1_000);
    expect(cooldowns.remaining(8, 1_000)).toBe(0);
  });

  test("tells subscribers when a cooldown starts", () => {
    const cooldowns = createRedoCooldowns();
    let calls = 0;
    cooldowns.subscribe(() => {
      calls += 1;
    });
    cooldowns.start(7, 1_000);
    expect(calls).toBe(1);
  });

  test("changes the snapshot when a cooldown starts", () => {
    const cooldowns = createRedoCooldowns();
    const before = cooldowns.getSnapshot();
    cooldowns.start(7, 1_000);
    expect(cooldowns.getSnapshot()).not.toBe(before);
  });

  test("keeps the same snapshot while nothing changes", () => {
    const cooldowns = createRedoCooldowns();
    expect(cooldowns.getSnapshot()).toBe(cooldowns.getSnapshot());
  });
});
