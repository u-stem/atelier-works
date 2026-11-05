import { describe, expect, test } from "bun:test";
import { isHoldsSnapshot } from "./holds.ts";

const BASE = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

describe("isHoldsSnapshot with stop_all", () => {
  test("accepts a snapshot without stop_all from an older backend", () => {
    expect(isHoldsSnapshot(BASE)).toBe(true);
  });

  test("accepts a placed stop", () => {
    expect(
      isHoldsSnapshot({
        ...BASE,
        stop_all: {
          kind: "active",
          placed_at: "2026-11-05T02:00:00.000Z",
          placed_by: "operator",
          reason: "loop",
        },
      }),
    ).toBe(true);
  });

  test("accepts an unreadable stop", () => {
    expect(
      isHoldsSnapshot({
        ...BASE,
        stop_all: { kind: "unreadable", reason: "r" },
      }),
    ).toBe(true);
  });

  test("rejects a placed stop without a time", () => {
    expect(
      isHoldsSnapshot({
        ...BASE,
        stop_all: { kind: "active", placed_by: "operator", reason: "loop" },
      }),
    ).toBe(false);
  });

  test("rejects a kind it does not know", () => {
    expect(isHoldsSnapshot({ ...BASE, stop_all: { kind: "paused" } })).toBe(
      false,
    );
  });
});
