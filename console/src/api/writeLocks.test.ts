import { describe, expect, test } from "bun:test";
import {
  AUDIT_WRITE_KEY,
  createWriteLocks,
  writeTargetKey,
} from "./writeLocks.ts";

describe("createWriteLocks", () => {
  test("grants the first acquire of a key", () => {
    const locks = createWriteLocks();
    expect(locks.tryAcquire("approval:3")).toBe(true);
  });

  test("refuses a second acquire of the same key", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(locks.tryAcquire("approval:3")).toBe(false);
  });

  test("grants a different key while one is held", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(locks.tryAcquire("approval:4")).toBe(true);
  });

  test("grants the key again after release", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    locks.release("approval:3");
    expect(locks.tryAcquire("approval:3")).toBe(true);
  });

  test("reports a held key as locked", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(locks.isLocked("approval:3")).toBe(true);
  });

  test("reports a released key as unlocked", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    locks.release("approval:3");
    expect(locks.isLocked("approval:3")).toBe(false);
  });

  test("ignores a release of a key that is not held", () => {
    const locks = createWriteLocks();
    expect(() => locks.release("approval:3")).not.toThrow();
  });
});

describe("createWriteLocks subscribe", () => {
  test("notifies when a key is acquired", () => {
    const locks = createWriteLocks();
    let calls = 0;
    locks.subscribe(() => {
      calls += 1;
    });
    locks.tryAcquire("approval:3");
    expect(calls).toBe(1);
  });

  test("notifies when a key is released", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    let calls = 0;
    locks.subscribe(() => {
      calls += 1;
    });
    locks.release("approval:3");
    expect(calls).toBe(1);
  });

  test("does not notify for a refused acquire", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    let calls = 0;
    locks.subscribe(() => {
      calls += 1;
    });
    locks.tryAcquire("approval:3");
    expect(calls).toBe(0);
  });

  test("does not notify after unsubscribe", () => {
    const locks = createWriteLocks();
    let calls = 0;
    const unsubscribe = locks.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    locks.tryAcquire("approval:3");
    expect(calls).toBe(0);
  });

  test("returns the same snapshot while nothing changes", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(locks.getSnapshot()).toBe(locks.getSnapshot());
  });

  test("returns a new snapshot after a change", () => {
    const locks = createWriteLocks();
    const before = locks.getSnapshot();
    locks.tryAcquire("approval:3");
    expect(locks.getSnapshot()).not.toBe(before);
  });

  test("includes the held keys in the snapshot", () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(locks.getSnapshot().has("approval:3")).toBe(true);
  });
});

describe("writeTargetKey", () => {
  test("builds a key from the kind and the id", () => {
    expect(writeTargetKey("approval", 3)).toBe("approval:3");
  });

  test("gives approval and work item ids separate keys", () => {
    expect(writeTargetKey("work_item", 3)).not.toBe(
      writeTargetKey("approval", 3),
    );
  });

  test("uses one fixed key for the audit kickoff", () => {
    expect(AUDIT_WRITE_KEY).toBe("audit");
  });
});
