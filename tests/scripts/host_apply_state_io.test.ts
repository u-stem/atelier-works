import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDrain, writeDrain } from "../../scripts/host_apply/drain_store.ts";
import { HeldLock } from "../../scripts/host_apply/held_lock.ts";
import {
  type Converging,
  type HostApplyState,
  newState,
} from "../../scripts/host_apply/state.ts";
import {
  commitApplied,
  createState,
  readState,
  reinit,
  type StackCheck,
  writeState,
} from "../../scripts/host_apply/state_io.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "fedcba9876543210fedcba9876543210fedcba98";
const AT = "2026-10-18T00:00:00Z";
const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const CONTAINER_A = "c".repeat(64);
const CONTAINER_B = "d".repeat(64);
const WORKER = "windmill_worker";
const uid = process.getuid?.() ?? 0;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function privateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "host-apply-state-io-"));
  roots.push(root);
  const dir = join(root, "state");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const held = new HeldLock(() => {});

function failingLock(): HeldLock {
  return new HeldLock(() => {
    throw new Error("lock lost");
  });
}

/** 呼ばれた後にロックを失う偽物。スタックの確認の最中にロックを失う場合に使う。 */
function losableLock(): { lock: HeldLock; lose: () => void } {
  let lost = false;
  return {
    lock: new HeldLock(() => {
      if (lost) throw new Error("lock lost");
    }),
    lose: () => {
      lost = true;
    },
  };
}

const matches: StackCheck = async () => true;
const mismatch: StackCheck = async () => false;
const APPLIED = { [WORKER]: { image_id: IMAGE_A, build_key: "k1" } };
const INPUT = {
  applied_sha: SHA,
  applied_images: APPLIED,
  stackMatches: matches,
};
const EMPTY_DRAIN = { schema: 1 as const, entries: {} };

function converging(patch: Partial<Converging> = {}): Converging {
  return {
    sha: NEXT,
    started_at: AT,
    executor_version: SHA,
    phase: "post",
    case: "B",
    forward_only: false,
    candidates: [WORKER],
    recreate: [WORKER],
    tags_changed: false,
    old_images: { [WORKER]: IMAGE_A },
    new_images: { [WORKER]: IMAGE_B },
    latest_before: { [WORKER]: IMAGE_A },
    old_containers: { [WORKER]: CONTAINER_A },
    drained: [],
    rolled: { [WORKER]: CONTAINER_B },
    confirmation: { at: AT, sha: NEXT, candidates: [WORKER] },
    ...patch,
  };
}

/** ビルドの途中の記録。ビルドの後に決まる欄は空にする。 */
function building(): Converging {
  return converging({
    phase: "build",
    case: null,
    rolled: {},
    recreate: [],
    old_containers: {},
    old_images: {},
    new_images: {},
    latest_before: null,
  });
}

async function created(dir: string): Promise<HostApplyState> {
  return createState(dir, INPUT, held, uid);
}

function stateFile(dir: string): string {
  return join(dir, "state.json");
}

function readOk(dir: string): HostApplyState {
  const result = readState(dir, uid);
  if (result.kind !== "ok") throw new Error(`state is ${result.kind}`);
  return result.state;
}

/** 失敗は別のテストで確かめる。ここでは、失敗の後の状態だけを見るために例外を捨てる。 */
async function ignoreFailure(run: () => Promise<unknown> | unknown) {
  try {
    await run();
  } catch {
    // 捨てる。
  }
}

/** 収束を`build`から`post`まで、許される遷移で1段ずつ進める。 */
async function inPost(dir: string): Promise<void> {
  const state = await created(dir);
  writeState(dir, { ...state, converging: building() }, held, uid);
  for (const phase of ["drain", "apply", "switch"] as const) {
    writeState(
      dir,
      {
        ...readOk(dir),
        converging: converging({
          phase,
          rolled: phase === "drain" ? {} : { [WORKER]: CONTAINER_B },
        }),
      },
      held,
      uid,
    );
  }
  writeState(dir, { ...readOk(dir), converging: converging() }, held, uid);
}

describe("readState", () => {
  test("is absent without a state file", () => {
    expect(readState(privateDir(), uid).kind).toBe("absent");
  });

  test("is absent without the directory", () => {
    expect(readState(join(privateDir(), "none"), uid).kind).toBe("absent");
  });

  test("reads back what createState wrote", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(readOk(dir)).toEqual(state);
  });

  test("is unsafe for a state file that others can read", async () => {
    const dir = privateDir();
    await created(dir);
    chmodSync(stateFile(dir), 0o644);
    expect(readState(dir, uid)).toMatchObject({
      kind: "state_unreadable",
      cause: "unsafe",
    });
  });

  test("is unsafe for a state file that is a symlink", () => {
    const dir = privateDir();
    const target = join(dir, "other");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, stateFile(dir));
    expect(readState(dir, uid)).toMatchObject({
      kind: "state_unreadable",
      cause: "unsafe",
    });
  });

  test("is a shape error for a body that is not a state", () => {
    const dir = privateDir();
    writeFileSync(stateFile(dir), '{"schema":2}', { mode: 0o600 });
    expect(readState(dir, uid)).toMatchObject({
      kind: "state_unreadable",
      cause: "shape",
    });
  });

  test("is a shape error for schema 1", () => {
    const dir = privateDir();
    writeFileSync(stateFile(dir), '{"schema":1}', { mode: 0o600 });
    expect(readState(dir, uid)).toMatchObject({
      reason: "unknown schema version",
    });
  });

  test("does not echo the body in the reason", () => {
    const dir = privateDir();
    writeFileSync(stateFile(dir), '{"secret":"hunter2hunter2"}', {
      mode: 0o600,
    });
    const result = readState(dir, uid);
    expect(
      result.kind === "state_unreadable" ? result.reason : "",
    ).not.toContain("hunter2");
  });
});

describe("createState", () => {
  test("writes a state file with mode 0600", async () => {
    const dir = privateDir();
    await created(dir);
    expect(statSync(stateFile(dir)).mode & 0o777).toBe(0o600);
  });

  test("starts with the applied sha and nothing converging", async () => {
    const dir = privateDir();
    expect(await created(dir)).toEqual(newState(SHA, APPLIED));
  });

  test("writes an empty drain record when there is none", async () => {
    const dir = privateDir();
    await created(dir);
    expect(readDrain(dir, uid)).toEqual({ kind: "found", record: EMPTY_DRAIN });
  });

  test("accepts an empty drain record that already exists", async () => {
    const dir = privateDir();
    writeDrain(dir, EMPTY_DRAIN, held, uid);
    await created(dir);
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("can start again from a directory that holds only drain.json", async () => {
    const dir = privateDir();
    writeDrain(dir, EMPTY_DRAIN, held, uid);
    expect(await created(dir)).toEqual(newState(SHA, APPLIED));
  });

  test("throws without the directory", async () => {
    const dir = join(privateDir(), "missing");
    await expect(created(dir)).rejects.toThrow();
  });

  test("does not create the directory", async () => {
    const dir = join(privateDir(), "missing");
    await ignoreFailure(() => created(dir));
    expect(existsSync(dir)).toBe(false);
  });

  test("fails when a state file exists", async () => {
    const dir = privateDir();
    await created(dir);
    await expect(
      createState(dir, { ...INPUT, applied_sha: NEXT }, held, uid),
    ).rejects.toThrow("already exists");
  });

  test("leaves an existing state file unchanged", async () => {
    const dir = privateDir();
    await created(dir);
    const before = readFileSync(stateFile(dir), "utf8");
    await ignoreFailure(() =>
      createState(dir, { ...INPUT, applied_sha: NEXT }, held, uid),
    );
    expect(readFileSync(stateFile(dir), "utf8")).toBe(before);
  });

  test("fails when a state file exists but is broken", async () => {
    const dir = privateDir();
    writeFileSync(stateFile(dir), "{", { mode: 0o600 });
    await expect(created(dir)).rejects.toThrow("already exists");
  });

  test("fails while drain.json has an entry", async () => {
    const dir = privateDir();
    writeDrain(
      dir,
      {
        schema: 1,
        entries: {
          [WORKER]: {
            container_id: CONTAINER_A,
            started_at: AT,
            signaled_at: AT,
            writer: "executor",
          },
        },
      },
      held,
      uid,
    );
    await expect(created(dir)).rejects.toThrow("drain file");
  });

  test("fails when drain.json is broken", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "drain.json"), "{", { mode: 0o600 });
    await expect(created(dir)).rejects.toThrow("drain file");
  });

  test("fails when the running stack does not match", async () => {
    const dir = privateDir();
    await expect(
      createState(dir, { ...INPUT, stackMatches: mismatch }, held, uid),
    ).rejects.toThrow("does not match");
  });

  test("fails when the stack check throws", async () => {
    const dir = privateDir();
    await expect(
      createState(
        dir,
        {
          ...INPUT,
          stackMatches: async () => {
            throw new Error("docker is down");
          },
        },
        held,
        uid,
      ),
    ).rejects.toThrow("docker is down");
  });

  test("writes nothing when the stack does not match", async () => {
    const dir = privateDir();
    await ignoreFailure(() =>
      createState(dir, { ...INPUT, stackMatches: mismatch }, held, uid),
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("passes the sha and the images to the stack check", async () => {
    const dir = privateDir();
    const seen: unknown[] = [];
    await createState(
      dir,
      {
        ...INPUT,
        stackMatches: async (sha, images) => {
          seen.push([sha, images]);
          return true;
        },
      },
      held,
      uid,
    );
    expect(seen).toEqual([[SHA, APPLIED]]);
  });

  test("does not write when the lock is lost", async () => {
    const dir = privateDir();
    await ignoreFailure(() => createState(dir, INPUT, failingLock(), uid));
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  test("does not write when the lock is lost during the stack check", async () => {
    const dir = privateDir();
    const { lock, lose } = losableLock();
    await ignoreFailure(() =>
      createState(
        dir,
        {
          ...INPUT,
          stackMatches: async () => {
            lose();
            return true;
          },
        },
        lock,
        uid,
      ),
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("does not overwrite a drain record that appears during the stack check", async () => {
    const dir = privateDir();
    await expect(
      createState(
        dir,
        {
          ...INPUT,
          stackMatches: async () => {
            writeFileSync(join(dir, "drain.json"), "{}", { mode: 0o600 });
            return true;
          },
        },
        held,
        uid,
      ),
    ).rejects.toThrow("appeared during the check");
  });

  test("leaves no temporary file behind", async () => {
    const dir = privateDir();
    await created(dir);
    expect(readdirSync(dir).sort()).toEqual(["drain.json", "state.json"]);
  });

  test("throws with a message that does not carry the sha", async () => {
    const dir = privateDir();
    const error = await createState(
      dir,
      { ...INPUT, stackMatches: mismatch },
      held,
      uid,
    ).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(SHA);
  });
});

describe("images that the stack check changes", () => {
  test("createState writes the images that it checked", async () => {
    const dir = privateDir();
    await createState(
      dir,
      {
        ...INPUT,
        applied_images: { [WORKER]: { image_id: IMAGE_A, build_key: "k1" } },
        stackMatches: async (_sha, images) => {
          const entry = images[WORKER];
          if (entry !== undefined) {
            Object.assign(entry, { image_id: IMAGE_B });
          }
          return true;
        },
      },
      held,
      uid,
    );
    expect(readOk(dir).applied_images[SHA]?.[WORKER]?.image_id).toBe(IMAGE_A);
  });

  test("commitApplied writes the images that it checked", async () => {
    const dir = privateDir();
    await inPost(dir);
    await commitApplied(
      dir,
      {
        images: { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } },
        outcome: "converged",
        now: AT,
        stackMatches: async (_sha, images) => {
          const entry = images[WORKER];
          if (entry !== undefined) {
            Object.assign(entry, { image_id: IMAGE_A });
          }
          return true;
        },
      },
      held,
      uid,
    );
    expect(readOk(dir).applied_images[NEXT]?.[WORKER]?.image_id).toBe(IMAGE_B);
  });
});

describe("input that is not a valid state", () => {
  test("createState does not call the stack check for a sha that is not a sha", async () => {
    const dir = privateDir();
    let calls = 0;
    await ignoreFailure(() =>
      createState(
        dir,
        {
          ...INPUT,
          applied_sha: "--all",
          stackMatches: async () => {
            calls += 1;
            return true;
          },
        },
        held,
        uid,
      ),
    );
    expect(calls).toBe(0);
  });

  test("reinit does not call the stack check for a sha that is not a sha", async () => {
    const dir = privateDir();
    await created(dir);
    let calls = 0;
    await ignoreFailure(() =>
      reinit(
        dir,
        {
          ...INPUT,
          applied_sha: "--all",
          stackMatches: async () => {
            calls += 1;
            return true;
          },
        },
        held,
        uid,
      ),
    );
    expect(calls).toBe(0);
  });
});

describe("writeState", () => {
  test("stores an update that keeps the applied state", async () => {
    const dir = privateDir();
    const state = await created(dir);
    writeState(dir, { ...state, attempts: 2 }, held, uid);
    expect(readOk(dir).attempts).toBe(2);
  });

  test("stores a converging record that starts at the build", async () => {
    const dir = privateDir();
    const state = await created(dir);
    writeState(dir, { ...state, converging: building() }, held, uid);
    expect(readOk(dir).converging?.sha).toBe(NEXT);
  });

  test("refuses a converging record that starts after the build", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(() =>
      writeState(
        dir,
        {
          ...state,
          converging: converging({ phase: "drain", rolled: {} }),
        },
        held,
        uid,
      ),
    ).toThrow("cannot change this way");
  });

  test("refuses a convergence that starts at the post", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(() =>
      writeState(dir, { ...state, converging: converging() }, held, uid),
    ).toThrow("cannot change this way");
  });

  test("refuses to change the applied sha", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(() =>
      writeState(
        dir,
        { ...state, applied_sha: NEXT, applied_images: { [NEXT]: APPLIED } },
        held,
        uid,
      ),
    ).toThrow("applied state cannot change");
  });

  test("keeps the applied sha when it refuses", async () => {
    const dir = privateDir();
    const state = await created(dir);
    await ignoreFailure(() =>
      writeState(
        dir,
        { ...state, applied_sha: NEXT, applied_images: { [NEXT]: APPLIED } },
        held,
        uid,
      ),
    );
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("refuses to change the applied images", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(() =>
      writeState(
        dir,
        {
          ...state,
          applied_images: {
            [SHA]: { [WORKER]: { image_id: IMAGE_B, build_key: "k1" } },
          },
        },
        held,
        uid,
      ),
    ).toThrow("applied state cannot change");
  });

  test("throws when there is no state file", () => {
    const dir = privateDir();
    expect(() => writeState(dir, newState(SHA, APPLIED), held, uid)).toThrow(
      "does not exist",
    );
  });

  test("does not create the state file when it throws", async () => {
    const dir = privateDir();
    await ignoreFailure(() =>
      writeState(dir, newState(SHA, APPLIED), held, uid),
    );
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  test("throws when the existing state file is broken", () => {
    const dir = privateDir();
    writeFileSync(stateFile(dir), "{", { mode: 0o600 });
    expect(() => writeState(dir, newState(SHA, APPLIED), held, uid)).toThrow(
      "not readable",
    );
  });

  test("does not write a state that fails the guard", async () => {
    const dir = privateDir();
    const state = await created(dir);
    expect(() =>
      writeState(dir, { ...state, attempts: -1 }, held, uid),
    ).toThrow("invalid state");
  });

  test("does not write when the lock is lost", async () => {
    const dir = privateDir();
    const state = await created(dir);
    await ignoreFailure(() =>
      writeState(dir, { ...state, attempts: 2 }, failingLock(), uid),
    );
    expect(readOk(dir).attempts).toBe(0);
  });

  test("asks the lock about the directory it writes to", async () => {
    const dir = privateDir();
    const state = await created(dir);
    const seen: string[] = [];
    const lock = new HeldLock((target) => {
      seen.push(target);
    });
    writeState(dir, { ...state, attempts: 1 }, lock, uid);
    expect(seen).toEqual([dir]);
  });

  test("checks the lock last, just before the write", async () => {
    const dir = privateDir();
    const state = await created(dir);
    const calls: boolean[] = [];
    const lock = new HeldLock(() => {
      calls.push(readOk(dir).attempts === 0);
    });
    writeState(dir, { ...state, attempts: 1 }, lock, uid);
    expect(calls).toEqual([true]);
  });
});

describe("commitApplied", () => {
  const images = { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } };
  const input = {
    images,
    outcome: "converged" as const,
    now: AT,
    stackMatches: matches,
  };

  test("moves the applied sha to the converging sha", async () => {
    const dir = privateDir();
    await inPost(dir);
    await commitApplied(dir, input, held, uid);
    expect(readOk(dir).applied_sha).toBe(NEXT);
  });

  test("clears the converging record", async () => {
    const dir = privateDir();
    await inPost(dir);
    await commitApplied(dir, input, held, uid);
    expect(readOk(dir).converging).toBeNull();
  });

  test("records the outcome", async () => {
    const dir = privateDir();
    await inPost(dir);
    await commitApplied(
      dir,
      { ...input, outcome: "finished_manually" },
      held,
      uid,
    );
    expect(readOk(dir).last_outcome?.kind).toBe("finished_manually");
  });

  test("fails without a converging record", async () => {
    const dir = privateDir();
    await created(dir);
    await expect(commitApplied(dir, input, held, uid)).rejects.toThrow(
      "ready to commit",
    );
  });

  test("fails for images that differ from the recorded ones", async () => {
    const dir = privateDir();
    await inPost(dir);
    await expect(
      commitApplied(
        dir,
        {
          ...input,
          images: { [WORKER]: { image_id: IMAGE_A, build_key: "k2" } },
        },
        held,
        uid,
      ),
    ).rejects.toThrow("images do not match");
  });

  test("fails for images that lack a recreated service", async () => {
    const dir = privateDir();
    await inPost(dir);
    await expect(
      commitApplied(dir, { ...input, images: {} }, held, uid),
    ).rejects.toThrow("images do not match");
  });

  test("fails when the running stack does not match", async () => {
    const dir = privateDir();
    await inPost(dir);
    await expect(
      commitApplied(dir, { ...input, stackMatches: mismatch }, held, uid),
    ).rejects.toThrow("does not match");
  });

  test("keeps the applied sha when the stack does not match", async () => {
    const dir = privateDir();
    await inPost(dir);
    await ignoreFailure(() =>
      commitApplied(dir, { ...input, stackMatches: mismatch }, held, uid),
    );
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("passes the new sha and the images to the stack check", async () => {
    const dir = privateDir();
    await inPost(dir);
    const seen: unknown[] = [];
    await commitApplied(
      dir,
      {
        ...input,
        stackMatches: async (sha, checked) => {
          seen.push([sha, checked]);
          return true;
        },
      },
      held,
      uid,
    );
    expect(seen).toEqual([[NEXT, images]]);
  });

  test("does not change the state when the lock is lost", async () => {
    const dir = privateDir();
    await inPost(dir);
    await ignoreFailure(() => commitApplied(dir, input, failingLock(), uid));
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("does not change the state when the lock is lost during the stack check", async () => {
    const dir = privateDir();
    await inPost(dir);
    const { lock, lose } = losableLock();
    await ignoreFailure(() =>
      commitApplied(
        dir,
        {
          ...input,
          stackMatches: async () => {
            lose();
            return true;
          },
        },
        lock,
        uid,
      ),
    );
    expect(readOk(dir).applied_sha).toBe(SHA);
  });
});

describe("reinit", () => {
  const reinitInput = {
    applied_sha: NEXT,
    applied_images: { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } },
    stackMatches: matches,
  };

  async function ready(): Promise<string> {
    const dir = privateDir();
    await created(dir);
    return dir;
  }

  test("replaces the applied sha when everything is in order", async () => {
    const dir = await ready();
    await reinit(dir, reinitInput, held, uid);
    expect(readOk(dir).applied_sha).toBe(NEXT);
  });

  test("starts over without the old rejections", async () => {
    const dir = await ready();
    writeState(
      dir,
      {
        ...readOk(dir),
        rejected: {
          [SHA]: { kind: "not_ff", at: AT, executor_version: SHA },
        },
      },
      held,
      uid,
    );
    await reinit(dir, reinitInput, held, uid);
    expect(readOk(dir).rejected).toEqual({});
  });

  test("passes the new sha and images to the stack check", async () => {
    const dir = await ready();
    const seen: unknown[] = [];
    await reinit(
      dir,
      {
        ...reinitInput,
        stackMatches: async (sha, images) => {
          seen.push([sha, images]);
          return true;
        },
      },
      held,
      uid,
    );
    expect(seen).toEqual([[NEXT, reinitInput.applied_images]]);
  });

  test("fails while a convergence is in progress", async () => {
    const dir = await ready();
    writeState(dir, { ...readOk(dir), converging: building() }, held, uid);
    await expect(reinit(dir, reinitInput, held, uid)).rejects.toThrow(
      "in progress",
    );
  });

  test("fails while drain.json has an entry", async () => {
    const dir = await ready();
    writeDrain(
      dir,
      {
        schema: 1,
        entries: {
          [WORKER]: {
            container_id: CONTAINER_A,
            started_at: AT,
            signaled_at: AT,
            writer: "executor",
          },
        },
      },
      held,
      uid,
    );
    await expect(reinit(dir, reinitInput, held, uid)).rejects.toThrow(
      "drain file",
    );
  });

  test("fails when drain.json is absent", async () => {
    const dir = await ready();
    rmSync(join(dir, "drain.json"));
    await expect(reinit(dir, reinitInput, held, uid)).rejects.toThrow(
      "drain file",
    );
  });

  test("fails when drain.json is broken", async () => {
    const dir = await ready();
    writeFileSync(join(dir, "drain.json"), "{", { mode: 0o600 });
    await expect(reinit(dir, reinitInput, held, uid)).rejects.toThrow(
      "drain file",
    );
  });

  test("fails when the running stack does not match", async () => {
    const dir = await ready();
    await expect(
      reinit(dir, { ...reinitInput, stackMatches: mismatch }, held, uid),
    ).rejects.toThrow("does not match");
  });

  test("fails when the stack check throws", async () => {
    const dir = await ready();
    await expect(
      reinit(
        dir,
        {
          ...reinitInput,
          stackMatches: async () => {
            throw new Error("docker is down");
          },
        },
        held,
        uid,
      ),
    ).rejects.toThrow("docker is down");
  });

  test("keeps the applied sha when the stack does not match", async () => {
    const dir = await ready();
    await ignoreFailure(() =>
      reinit(dir, { ...reinitInput, stackMatches: mismatch }, held, uid),
    );
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("fails without a state file", async () => {
    const dir = privateDir();
    writeDrain(dir, EMPTY_DRAIN, held, uid);
    await expect(reinit(dir, reinitInput, held, uid)).rejects.toThrow(
      "does not exist",
    );
  });

  test("does not change the state when the lock is lost", async () => {
    const dir = await ready();
    await ignoreFailure(() => reinit(dir, reinitInput, failingLock(), uid));
    expect(readOk(dir).applied_sha).toBe(SHA);
  });

  test("does not change the state when the lock is lost during the stack check", async () => {
    const dir = await ready();
    const { lock, lose } = losableLock();
    await ignoreFailure(() =>
      reinit(
        dir,
        {
          ...reinitInput,
          stackMatches: async () => {
            lose();
            return true;
          },
        },
        lock,
        uid,
      ),
    );
    expect(readOk(dir).applied_sha).toBe(SHA);
  });
});

describe("the fence receives the state directory", () => {
  function recordingLock(): { lock: HeldLock; seen: string[] } {
    const seen: string[] = [];
    return {
      lock: new HeldLock((target) => {
        seen.push(target);
      }),
      seen,
    };
  }

  test("createState passes it for the state file and the drain file", async () => {
    const dir = privateDir();
    const { lock, seen } = recordingLock();
    await createState(dir, INPUT, lock, uid);
    expect(seen).toEqual([dir, dir]);
  });

  test("commitApplied passes it", async () => {
    const dir = privateDir();
    await inPost(dir);
    const { lock, seen } = recordingLock();
    await commitApplied(
      dir,
      {
        images: { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } },
        outcome: "converged",
        now: AT,
        stackMatches: matches,
      },
      lock,
      uid,
    );
    expect(seen).toEqual([dir]);
  });

  test("reinit passes it", async () => {
    const dir = privateDir();
    await created(dir);
    const { lock, seen } = recordingLock();
    await reinit(
      dir,
      {
        applied_sha: NEXT,
        applied_images: { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } },
        stackMatches: matches,
      },
      lock,
      uid,
    );
    expect(seen).toEqual([dir]);
  });
});
