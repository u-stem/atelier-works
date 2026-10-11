import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  AUDIT_WRITE_KEY,
  createWriteLocks,
  runLocked,
  writeTargetKey,
} from "./writeLocks.ts";

describe("runLocked", () => {
  const SETTLED = { value: "done", keepLocked: false } as const;

  test("does not run while the key is held", async () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    let ran = false;
    await runLocked(
      locks,
      "approval:3",
      () => {
        ran = true;
        return Promise.resolve(SETTLED);
      },
      () => undefined,
    );
    expect(ran).toBe(false);
  });

  test("reports that it did not start while the key is held", async () => {
    const locks = createWriteLocks();
    locks.tryAcquire("approval:3");
    expect(
      await runLocked(
        locks,
        "approval:3",
        () => Promise.resolve(SETTLED),
        () => undefined,
      ),
    ).toEqual({ started: false });
  });

  test("holds the key while it runs", async () => {
    const locks = createWriteLocks();
    let lockedInside = false;
    await runLocked(
      locks,
      "approval:3",
      () => {
        lockedInside = locks.isLocked("approval:3");
        return Promise.resolve(SETTLED);
      },
      () => undefined,
    );
    expect(lockedInside).toBe(true);
  });

  test("refuses a second run of the same key while the first is running", async () => {
    const locks = createWriteLocks();
    let finish: () => void = () => undefined;
    const first = runLocked(
      locks,
      "approval:3",
      () =>
        new Promise<typeof SETTLED>((resolve) => {
          finish = () => resolve(SETTLED);
        }),
      () => undefined,
    );
    const second = await runLocked(
      locks,
      "approval:3",
      () => Promise.resolve(SETTLED),
      () => undefined,
    );
    finish();
    await first;
    expect(second).toEqual({ started: false });
  });

  test("returns the value of the run", async () => {
    const locks = createWriteLocks();
    expect(
      await runLocked(
        locks,
        "approval:3",
        () => Promise.resolve(SETTLED),
        () => undefined,
      ),
    ).toEqual({ started: true, value: "done" });
  });

  test("releases the key after the run", async () => {
    const locks = createWriteLocks();
    await runLocked(
      locks,
      "approval:3",
      () => Promise.resolve(SETTLED),
      () => undefined,
    );
    expect(locks.isLocked("approval:3")).toBe(false);
  });

  test("rethrows an ApiFailure of the run", async () => {
    const locks = createWriteLocks();
    const attempt = runLocked(
      locks,
      "approval:3",
      () => Promise.reject(new ApiFailure({ kind: "network" })),
      () => undefined,
    );
    await expect(attempt).rejects.toBeInstanceOf(ApiFailure);
  });

  test("releases the key when the run fails with an ApiFailure", async () => {
    const locks = createWriteLocks();
    await runLocked(
      locks,
      "approval:3",
      () => Promise.reject(new ApiFailure({ kind: "network" })),
      () => undefined,
    ).catch(() => undefined);
    expect(locks.isLocked("approval:3")).toBe(false);
  });

  test("rethrows another error of the run", async () => {
    const locks = createWriteLocks();
    const attempt = runLocked(
      locks,
      "approval:3",
      () => Promise.reject(new TypeError("bug")),
      () => undefined,
    );
    await expect(attempt).rejects.toThrow("bug");
  });

  test("releases the key when the run throws another error", async () => {
    const locks = createWriteLocks();
    await runLocked(
      locks,
      "approval:3",
      () => Promise.reject(new TypeError("bug")),
      () => undefined,
    ).catch(() => undefined);
    expect(locks.isLocked("approval:3")).toBe(false);
  });

  test("keeps the key held when the run asks for it", async () => {
    const locks = createWriteLocks();
    await runLocked(
      locks,
      "approval:3",
      () => Promise.resolve({ value: "done", keepLocked: true }),
      () => undefined,
    );
    expect(locks.isLocked("approval:3")).toBe(true);
  });

  test("hands a release to the holder when it keeps the key", async () => {
    const locks = createWriteLocks();
    let release: () => void = () => undefined;
    await runLocked(
      locks,
      "approval:3",
      () => Promise.resolve({ value: "done", keepLocked: true }),
      (fn) => {
        release = fn;
      },
    );
    release();
    expect(locks.isLocked("approval:3")).toBe(false);
  });

  test("does not call the holder when it releases the key", async () => {
    const locks = createWriteLocks();
    let held = false;
    await runLocked(
      locks,
      "approval:3",
      () => Promise.resolve(SETTLED),
      () => {
        held = true;
      },
    );
    expect(held).toBe(false);
  });
});

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
