import { describe, expect, test } from "bun:test";
import { isHoldsSnapshot } from "./holds.ts";

const T0 = "2026-10-24T02:00:00.000Z";
const T1 = "2026-10-24T04:00:00.000Z";

const HOLD = {
  id: 7,
  scope: "merge",
  target: "octo/repo",
  reason: "wait",
  holder_kind: "session",
  holder: "session:feat/x",
  created_at: T0,
  expires_at: T1,
};

const SCHEDULE = {
  id: "0a1b2c3d",
  target: "f/factory/poll_issues",
  reason: "verify",
  holder_kind: "session",
  holder: "session:feat/y",
  created_at: T0,
  expires_at: T1,
};

const DEPLOY = {
  id: "1b2c3d4e",
  reason: "migration",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const SNAPSHOT = {
  holds: { ok: true, rows: [HOLD] },
  freezes: { ok: true, schedule: [SCHEDULE], deploy: [DEPLOY] },
};

const EMPTY = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

function withHolds(holds: unknown): unknown {
  return { ...SNAPSHOT, holds };
}

function withFreezes(freezes: unknown): unknown {
  return { ...SNAPSHOT, freezes };
}

describe("isHoldsSnapshot accepts", () => {
  test("a snapshot with every kind of row", () => {
    expect(isHoldsSnapshot(SNAPSHOT)).toBe(true);
  });

  test("a snapshot with nothing active", () => {
    expect(isHoldsSnapshot(EMPTY)).toBe(true);
  });

  test("a claim hold", () => {
    expect(
      isHoldsSnapshot(
        withHolds({ ok: true, rows: [{ ...HOLD, scope: "claim" }] }),
      ),
    ).toBe(true);
  });

  test("a scope the console does not know yet", () => {
    expect(
      isHoldsSnapshot(
        withHolds({ ok: true, rows: [{ ...HOLD, scope: "deploy2" }] }),
      ),
    ).toBe(true);
  });

  test("a holder kind the console does not know yet", () => {
    expect(
      isHoldsSnapshot(
        withHolds({ ok: true, rows: [{ ...HOLD, holder_kind: "robot" }] }),
      ),
    ).toBe(true);
  });

  test.each(["missing_table", "read_failed", "corrupt"])(
    "a hold read that failed as %s",
    (kind) => {
      expect(
        isHoldsSnapshot(withHolds({ ok: false, kind, reason: "why" })),
      ).toBe(true);
    },
  );

  test("a failure kind the console does not know yet", () => {
    expect(
      isHoldsSnapshot(withHolds({ ok: false, kind: "timeout", reason: "why" })),
    ).toBe(true);
  });

  test("a freeze read that failed", () => {
    expect(isHoldsSnapshot(withFreezes({ ok: false, reason: "why" }))).toBe(
      true,
    );
  });
});

describe("isHoldsSnapshot rejects", () => {
  test.each([[null], [undefined], ["x"], [1], [[]], [{}]])(
    "the value %p",
    (value) => {
      expect(isHoldsSnapshot(value)).toBe(false);
    },
  );

  test("a snapshot without the freezes", () => {
    expect(isHoldsSnapshot({ holds: SNAPSHOT.holds })).toBe(false);
  });

  test("a hold read without a boolean ok", () => {
    expect(isHoldsSnapshot(withHolds({ ok: "yes", rows: [] }))).toBe(false);
  });

  test("a successful hold read without rows", () => {
    expect(isHoldsSnapshot(withHolds({ ok: true }))).toBe(false);
  });

  test("a failed hold read without a reason", () => {
    expect(isHoldsSnapshot(withHolds({ ok: false, kind: "corrupt" }))).toBe(
      false,
    );
  });

  test("a failed hold read without a kind", () => {
    expect(isHoldsSnapshot(withHolds({ ok: false, reason: "why" }))).toBe(
      false,
    );
  });

  test("a hold with a string id", () => {
    expect(
      isHoldsSnapshot(withHolds({ ok: true, rows: [{ ...HOLD, id: "7" }] })),
    ).toBe(false);
  });

  test("a hold with a zero id", () => {
    expect(
      isHoldsSnapshot(withHolds({ ok: true, rows: [{ ...HOLD, id: 0 }] })),
    ).toBe(false);
  });

  test("a hold whose time has no offset", () => {
    expect(
      isHoldsSnapshot(
        withHolds({
          ok: true,
          rows: [{ ...HOLD, expires_at: "2026-10-24T04:00:00" }],
        }),
      ),
    ).toBe(false);
  });

  test("a hold without a reason", () => {
    const { reason: _omitted, ...rest } = HOLD;
    expect(isHoldsSnapshot(withHolds({ ok: true, rows: [rest] }))).toBe(false);
  });

  test("a schedule freeze with a numeric id", () => {
    expect(
      isHoldsSnapshot(
        withFreezes({
          ok: true,
          schedule: [{ ...SCHEDULE, id: 3 }],
          deploy: [],
        }),
      ),
    ).toBe(false);
  });

  test("a schedule freeze without a target", () => {
    const { target: _omitted, ...rest } = SCHEDULE;
    expect(
      isHoldsSnapshot(withFreezes({ ok: true, schedule: [rest], deploy: [] })),
    ).toBe(false);
  });

  test("a successful freeze read without the deploy list", () => {
    expect(
      isHoldsSnapshot(withFreezes({ ok: true, schedule: [SCHEDULE] })),
    ).toBe(false);
  });

  test("a failed freeze read without a reason", () => {
    expect(isHoldsSnapshot(withFreezes({ ok: false }))).toBe(false);
  });
});
