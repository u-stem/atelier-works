import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStart } from "../../scripts/host_apply/host_probe.ts";
import {
  type AcquireResult,
  acquireLock,
  acquireLockForTest,
  type LockDeps,
  type LockHandle,
  type LockIo,
  resetOwnerRecord,
  resetOwnerRecordForTest,
} from "../../scripts/host_apply/lock.ts";
import {
  createRunner,
  defaultKillGroup,
} from "../../scripts/host_apply/spawn_runner.ts";

const uid = process.getuid?.() ?? 0;
const REAL = process.platform === "darwin";
const RECORD_SIZE = 1024;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function privateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "host-apply-lock-"));
  roots.push(root);
  const dir = join(root, "state");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const AT = "2026-10-18T10:00:00Z";
const EARLY = "2026-10-18T09:59:30Z";

function deps(patch: Partial<LockDeps> = {}): LockDeps {
  return {
    uid,
    pid: 4242,
    now: () => AT,
    processStart: async () => null,
    groupExists: () => false,
    ...patch,
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** プロセスの中だけで排他を模す偽の`openLocked`。CIのLinuxでも同じ振る舞いを検証するために使う。 */
function fakeIo(
  extra: NonNullable<LockIo["hooks"]> = {},
): LockIo & { openFds: () => number } {
  const held = new Map<number, string>();
  return {
    openLocked(path, { create }) {
      const flags =
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        (create ? constants.O_CREAT : 0);
      const fd = openSync(path, flags, 0o600);
      const stat = fstatSync(fd, { bigint: true });
      const key = `${stat.dev}:${stat.ino}`;
      if ([...held.values()].includes(key)) {
        closeSync(fd);
        throw errno("EAGAIN");
      }
      held.set(fd, key);
      return fd;
    },
    closeLocked(fd) {
      held.delete(fd);
      closeSync(fd);
    },
    hooks: extra,
    openFds: () => held.size,
  };
}

/** 書き込みを後から失敗させたり短くしたりできる偽のio。 */
function switchableIo() {
  const control: { mode: "ok" | "throw" | "short" } = { mode: "ok" };
  const io = fakeIo({
    write: (fd, body) => {
      if (control.mode === "throw") throw errno("EIO");
      if (control.mode === "short") return 10;
      return writeSync(fd, body, 0, body.length, 0);
    },
  });
  return { io, control };
}

type Group = { pgid: number; from: string; to: string };
type Rec = {
  schema: 1;
  holder: { pid: number; acquired_at: string } | null;
  groups: Group[];
};

function seed(dir: string, record: unknown, mode = 0o600): void {
  const text = JSON.stringify(record).padEnd(RECORD_SIZE, " ");
  writeFileSync(join(dir, "lock"), text, { mode });
  chmodSync(join(dir, "lock"), mode);
}

function emptyLock(dir: string): void {
  writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
  chmodSync(join(dir, "lock"), 0o600);
}

function readRecord(dir: string): Rec {
  return JSON.parse(readFileSync(join(dir, "lock"), "utf8").trimEnd());
}

function lockSize(dir: string): number {
  return statSync(join(dir, "lock")).size;
}

const opened: LockHandle[] = [];
afterEach(() => {
  for (const handle of opened.splice(0)) handle.release();
});

async function take(
  dir: string,
  d: LockDeps = deps(),
  io: LockIo = fakeIo(),
  create = true,
): Promise<AcquireResult> {
  const result = await acquireLockForTest(dir, d, io, { create });
  if (result.kind === "held") opened.push(result.handle);
  return result;
}

async function held(
  dir: string,
  d: LockDeps = deps(),
  io: LockIo = fakeIo(),
): Promise<LockHandle> {
  const result = await take(dir, d, io);
  if (result.kind !== "held") throw new Error(`not held: ${result.kind}`);
  return result.handle;
}

function group(pgid: number, from = EARLY, to = AT): Group {
  return { pgid, from, to };
}

function rec(groups: Group[] = [], holder: Rec["holder"] = null): Rec {
  return { schema: 1, holder, groups };
}

describe("acquireLock with a fake kernel lock", () => {
  test("holds a lock in an empty state directory", async () => {
    expect((await take(privateDir())).kind).toBe("held");
  });

  test("is blocked as absent when the state directory is missing", async () => {
    const result = await take(join(privateDir(), "missing"));
    expect(result).toEqual({
      kind: "blocked",
      cause: "absent",
      reason: "state directory does not exist",
    });
  });

  test("is blocked as unsafe when the state directory is open to others", async () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe for a path that is not absolute", async () => {
    const result = await take("relative/state");
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as lock_absent without create when there is no lock file", async () => {
    const result = await take(privateDir(), deps(), fakeIo(), false);
    expect(result.kind === "blocked" && result.cause).toBe("lock_absent");
  });

  test("does not create the lock file without create", async () => {
    const dir = privateDir();
    await take(dir, deps(), fakeIo(), false);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  test("creates the lock file with mode 0600 when asked to create", async () => {
    const dir = privateDir();
    await take(dir);
    expect(statSync(join(dir, "lock")).mode & 0o777).toBe(0o600);
  });

  test("a second acquisition is busy", async () => {
    const dir = privateDir();
    const io = fakeIo();
    await take(dir, deps(), io);
    expect((await take(dir, deps(), io)).kind).toBe("busy");
  });

  test("busy reports the pid of the holder", async () => {
    const dir = privateDir();
    const io = fakeIo();
    await take(dir, deps({ pid: 777 }), io);
    const result = await take(dir, deps(), io);
    expect(result.kind === "busy" && result.holder?.pid).toBe(777);
  });

  test("busy reports no holder when the record is broken", async () => {
    const dir = privateDir();
    const io = fakeIo();
    await take(dir, deps(), io);
    writeFileSync(join(dir, "lock"), "x".repeat(RECORD_SIZE));
    const result = await take(dir, deps(), io);
    expect(result.kind === "busy" && result.holder).toBeNull();
  });

  test("can be taken again after release", async () => {
    const dir = privateDir();
    const io = fakeIo();
    (await held(dir, deps(), io)).release();
    expect((await take(dir, deps(), io)).kind).toBe("held");
  });

  test("release is idempotent", async () => {
    const handle = await held(privateDir());
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  test("release closes the file descriptor", async () => {
    const io = fakeIo();
    const handle = await held(privateDir(), deps(), io);
    handle.release();
    expect(io.openFds()).toBe(0);
  });

  test("is blocked as unsupported when the second open succeeds", async () => {
    const dir = privateDir();
    const io: LockIo = {
      ...fakeIo(),
      openLocked: (path, { create }) =>
        openSync(
          path,
          constants.O_RDWR | (create ? constants.O_CREAT : 0),
          0o600,
        ),
      closeLocked: closeSync,
    };
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("unsupported");
  });

  test("writes no record when the self check fails", async () => {
    const dir = privateDir();
    const io: LockIo = {
      openLocked: (path, { create }) =>
        openSync(
          path,
          constants.O_RDWR | (create ? constants.O_CREAT : 0),
          0o600,
        ),
      closeLocked: closeSync,
    };
    await take(dir, deps(), io);
    expect(lockSize(dir)).toBe(0);
  });

  test("is blocked as io when the self check fails for another reason", async () => {
    const dir = privateDir();
    const base = fakeIo();
    let calls = 0;
    const io: LockIo = {
      ...base,
      openLocked: (path, opts) => {
        calls += 1;
        if (calls === 2) throw errno("EMFILE");
        return base.openLocked(path, opts);
      },
    };
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("is blocked as unsafe when the self check opens another inode", async () => {
    const dir = privateDir();
    const base = fakeIo();
    let calls = 0;
    const io: LockIo = {
      ...base,
      openLocked: (path, opts) => {
        calls += 1;
        if (calls === 2) {
          const other = join(dir, "other");
          writeFileSync(other, "");
          return openSync(other, constants.O_RDWR);
        }
        return base.openLocked(path, opts);
      },
    };
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as io when the open fails for another reason", async () => {
    const io: LockIo = {
      ...fakeIo(),
      openLocked: () => {
        throw errno("EIO");
      },
    };
    const result = await take(privateDir(), deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("is blocked as unsafe when the lock file is a symlink", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "lock"));
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the lock file is a directory", async () => {
    const dir = privateDir();
    mkdirSync(join(dir, "lock"));
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the lock file is open to others", async () => {
    const dir = privateDir();
    seed(dir, rec(), 0o644);
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when another user owns the lock file", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const result = await take(dir, deps({ uid: uid + 1 }));
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the lock file has another link", async () => {
    const dir = privateDir();
    emptyLock(dir);
    linkSync(join(dir, "lock"), join(dir, "lock2"));
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the lock file is replaced after the open", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const io = fakeIo({
      afterOpen: (path) => {
        renameSync(path, `${path}.moved`);
        writeFileSync(path, "", { mode: 0o600 });
      },
    });
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the lock file is removed after the open", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const io = fakeIo({ afterOpen: (path) => rmSync(path) });
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as unsafe when the state directory is replaced after the open", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const io = fakeIo({
      afterOpen: () => {
        renameSync(dir, `${dir}.moved`);
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
      },
    });
    const result = await take(dir, deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("closes the descriptor when a check fails", async () => {
    const dir = privateDir();
    seed(dir, rec(), 0o644);
    const io = fakeIo();
    await take(dir, deps(), io);
    expect(io.openFds()).toBe(0);
  });

  test("never puts the path or an error message in a reason", async () => {
    const dir = privateDir();
    seed(dir, rec(), 0o644);
    const result = await take(dir);
    expect(result.kind === "blocked" && result.reason.includes("/")).toBe(
      false,
    );
  });
});

describe("the owner record", () => {
  test("is blocked as owner_unreadable for a body that is not JSON", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "lock"), "x".repeat(RECORD_SIZE), { mode: 0o600 });
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("owner_unreadable");
  });

  test("accepts an empty file", async () => {
    const dir = privateDir();
    emptyLock(dir);
    expect((await take(dir)).kind).toBe("held");
  });

  test("accepts a record that only needs space padding", async () => {
    const dir = privateDir();
    seed(dir, rec());
    expect((await take(dir)).kind).toBe("held");
  });

  test.each([
    ["an unknown top-level key", { ...rec(), extra: 1 }],
    ["a wrong schema", { ...rec(), schema: 2 }],
    [
      "a holder with an unknown key",
      {
        ...rec([], { pid: 1, acquired_at: AT }),
        holder: { pid: 1, acquired_at: AT, x: 1 },
      },
    ],
    ["a holder pid of zero", rec([], { pid: 0, acquired_at: AT })],
    [
      "a holder time that is not in seconds",
      rec([], { pid: 1, acquired_at: "2026-10-18T10:00:00.5Z" }),
    ],
    [
      "a group with an unknown key",
      { ...rec(), groups: [{ ...group(5), x: 1 }] },
    ],
    ["a pgid of zero", rec([group(0)])],
    ["a pgid of one", rec([group(1)])],
    ["a negative pgid", rec([group(-1)])],
    ["a fractional pgid", rec([group(5.5)])],
    ["a pgid above the process id limit", rec([group(4194305)])],
    ["a duplicate pgid", rec([group(5), group(5)])],
    ["nine groups", rec([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => group(n)))],
    ["a from after to", rec([group(5, AT, EARLY)])],
    [
      "a group time that is not in seconds",
      rec([group(5, "2026-10-18T10:00:00.1Z", AT)]),
    ],
  ])("is blocked as owner_unreadable for %s", async (_name, record) => {
    const dir = privateDir();
    seed(dir, record);
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("owner_unreadable");
  });

  test.each([
    ["shorter than the record size", 100],
    ["longer than the record size", RECORD_SIZE + 1],
  ])(
    "is blocked as owner_unreadable when the file is %s",
    async (_name, size) => {
      const dir = privateDir();
      writeFileSync(join(dir, "lock"), " ".repeat(size), { mode: 0o600 });
      const result = await take(dir);
      expect(result.kind === "blocked" && result.cause).toBe(
        "owner_unreadable",
      );
    },
  );

  test("writes the pid of the holder", async () => {
    const dir = privateDir();
    await held(dir, deps({ pid: 555 }));
    expect(readRecord(dir).holder?.pid).toBe(555);
  });

  test("writes the acquisition time", async () => {
    const dir = privateDir();
    await held(dir);
    expect(readRecord(dir).holder?.acquired_at).toBe(AT);
  });

  test("writes no groups at first", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    await held(dir);
    expect(readRecord(dir).groups).toEqual([]);
  });

  test("always writes a record of exactly 1024 bytes", async () => {
    const dir = privateDir();
    await held(dir);
    expect(lockSize(dir)).toBe(RECORD_SIZE);
  });

  test("is blocked as io when now is not in seconds", async () => {
    const dir = privateDir();
    const result = await take(
      dir,
      deps({ now: () => "2026-10-18T10:00:00.5Z" }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("a record of eight groups at the widest values fits in 1024 bytes", async () => {
    const dir = privateDir();
    const widest = "2026-12-31T23:59:59Z";
    const handle = await held(
      dir,
      deps({ pid: 4194304, now: () => widest, groupExists: () => true }),
    );
    for (let n = 0; n < 8; n += 1) {
      handle.trackGroup(4194296 + n, widest);
    }
    expect(lockSize(dir)).toBe(RECORD_SIZE);
  });
});

describe("orphans from the previous holder", () => {
  const later = (s: string) => async () => s;

  test("acquires when none of the recorded groups exist", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    expect((await take(dir, deps({ groupExists: () => false }))).kind).toBe(
      "held",
    );
  });

  test("stops while a recorded group still exists", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(dir, deps({ groupExists: () => true }));
    expect(result.kind).toBe("orphan_alive");
  });

  test("reports only the groups that exist", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5), group(6)]));
    const result = await take(dir, deps({ groupExists: (pgid) => pgid === 6 }));
    expect(result.kind === "orphan_alive" && result.pgids).toEqual([6]);
  });

  test("does not rewrite the record while an orphan exists", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const before = readFileSync(join(dir, "lock"), "utf8");
    await take(dir, deps({ groupExists: () => true }));
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(before);
  });

  test("closes the descriptor while an orphan exists", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const io = fakeIo();
    await take(dir, deps({ groupExists: () => true }), io);
    expect(io.openFds()).toBe(0);
  });

  test("stops again on the next acquisition", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const io = fakeIo();
    const d = deps({ groupExists: () => true });
    await take(dir, d, io);
    expect((await take(dir, d, io)).kind).toBe("orphan_alive");
  });

  test("a leader that started inside the interval is a real orphan", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: later("2026-10-18T09:59:45Z"),
      }),
    );
    expect(result.kind).toBe("orphan_alive");
  });

  test("a leader that started one second before from is a real orphan", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: later("2026-10-18T09:59:29Z"),
      }),
    );
    expect(result.kind).toBe("orphan_alive");
  });

  test("a leader that started one second after to is a real orphan", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: later("2026-10-18T10:00:01Z"),
      }),
    );
    expect(result.kind).toBe("orphan_alive");
  });

  test("a leader that started two seconds before from is a reused pid", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: later("2026-10-18T09:59:28Z"),
      }),
    );
    expect(result.kind).toBe("held");
  });

  test("a leader that started two seconds after to is a reused pid", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: later("2026-10-18T10:00:02Z"),
      }),
    );
    expect(result.kind).toBe("held");
  });

  test("a group without a leader is a real orphan", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({ groupExists: () => true, processStart: async () => null }),
    );
    expect(result.kind).toBe("orphan_alive");
  });

  test("does not ask for the start time of a group that does not exist", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    let asked = 0;
    await take(
      dir,
      deps({
        groupExists: () => false,
        processStart: async () => {
          asked += 1;
          return null;
        },
      }),
    );
    expect(asked).toBe(0);
  });

  test("is blocked as io when groupExists throws", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("is blocked as io when processStart throws", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("is blocked as io when processStart returns a malformed time", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({ groupExists: () => true, processStart: later("yesterday") }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("does not ask about groups when the record has none", async () => {
    const dir = privateDir();
    seed(dir, rec());
    let asked = 0;
    await take(
      dir,
      deps({
        groupExists: () => {
          asked += 1;
          return false;
        },
      }),
    );
    expect(asked).toBe(0);
  });
});

describe("trackGroup", () => {
  test("adds the group with its interval to the record", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    handle.trackGroup(300, EARLY);
    expect(readRecord(dir).groups).toEqual([group(300, EARLY, AT)]);
  });

  test("returns nothing, not a promise", async () => {
    const handle = await held(privateDir());
    expect(handle.trackGroup(300, EARLY)).toBeUndefined();
  });

  test.each([
    ["zero", 0],
    ["one", 1],
    ["a negative number", -1],
    ["a fractional number", 5.5],
    ["above the process id limit", 4194305],
    ["not a number", Number.NaN],
  ])("throws for a pgid that is %s", async (_name, pgid) => {
    const handle = await held(privateDir());
    expect(() => handle.trackGroup(pgid, EARLY)).toThrow();
  });

  test("throws for the pid of the holder itself", async () => {
    const handle = await held(privateDir(), deps({ pid: 4242 }));
    expect(() => handle.trackGroup(4242, EARLY)).toThrow();
  });

  test("throws for a before that is not in seconds", async () => {
    const handle = await held(privateDir());
    expect(() => handle.trackGroup(300, "2026-10-18T09:59:30.5Z")).toThrow();
  });

  test("throws for a before that is later than now", async () => {
    const handle = await held(privateDir());
    expect(() => handle.trackGroup(300, "2026-10-18T10:00:05Z")).toThrow();
  });

  test("throws for a before more than sixty seconds before now", async () => {
    const handle = await held(privateDir());
    expect(() => handle.trackGroup(300, "2026-10-18T09:58:59Z")).toThrow();
  });

  test("accepts a before exactly sixty seconds before now", async () => {
    const handle = await held(privateDir());
    expect(() => handle.trackGroup(300, "2026-10-18T09:59:00Z")).not.toThrow();
  });

  test("throws for a now that is not in seconds", async () => {
    let current = AT;
    const handle = await held(privateDir(), deps({ now: () => current }));
    current = "2026-10-18T10:00:00.5Z";
    expect(() => handle.trackGroup(300, EARLY)).toThrow();
  });

  test("replaces an older entry for the same pgid", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    handle.trackGroup(300, EARLY);
    handle.trackGroup(300, "2026-10-18T09:59:50Z");
    expect(readRecord(dir).groups).toEqual([
      group(300, "2026-10-18T09:59:50Z", AT),
    ]);
  });

  test("throws for the ninth group", async () => {
    const handle = await held(privateDir(), deps({ groupExists: () => true }));
    for (let n = 0; n < 8; n += 1) handle.trackGroup(300 + n, EARLY);
    expect(() => handle.trackGroup(400, EARLY)).toThrow();
  });

  test("sweeps groups that no longer exist before checking the limit", async () => {
    const alive = new Set<number>();
    const dir = privateDir();
    const handle = await held(
      dir,
      deps({ groupExists: (pgid) => alive.has(pgid) }),
    );
    for (let n = 0; n < 8; n += 1) handle.trackGroup(300 + n, EARLY);
    handle.trackGroup(400, EARLY);
    expect(readRecord(dir).groups.map((g) => g.pgid)).toEqual([400]);
  });

  test("keeps a group when groupExists throws during the sweep", async () => {
    let failing = false;
    const dir = privateDir();
    const handle = await held(
      dir,
      deps({
        groupExists: () => {
          if (failing) throw new Error("boom");
          return true;
        },
      }),
    );
    handle.trackGroup(300, EARLY);
    failing = true;
    handle.trackGroup(301, EARLY);
    expect(readRecord(dir).groups.map((g) => g.pgid)).toEqual([300, 301]);
  });

  test("throws after release", async () => {
    const handle = await held(privateDir());
    handle.release();
    expect(() => handle.trackGroup(300, EARLY)).toThrow();
  });

  test("throws after the lock file was replaced", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    renameSync(join(dir, "lock"), join(dir, "lock.moved"));
    writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
    expect(() => handle.trackGroup(300, EARLY)).toThrow();
  });

  test("does not change the record when the limit is exceeded", async () => {
    const dir = privateDir();
    const handle = await held(dir, deps({ groupExists: () => true }));
    for (let n = 0; n < 8; n += 1) handle.trackGroup(300 + n, EARLY);
    const before = readFileSync(join(dir, "lock"), "utf8");
    try {
      handle.trackGroup(400, EARLY);
    } catch {
      // 例外は別のテストで確かめる。
    }
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(before);
  });

  test("leaves the in-memory groups unchanged when the limit is exceeded", async () => {
    const dir = privateDir();
    const handle = await held(dir, deps({ groupExists: () => true }));
    for (let n = 0; n < 8; n += 1) handle.trackGroup(300 + n, EARLY);
    try {
      handle.trackGroup(400, EARLY);
    } catch {
      // 例外は別のテストで確かめる。
    }
    expect(handle.untrackGroup(400)).toBe(true);
  });
});

describe("untrackGroup", () => {
  test("removes a group that no longer exists", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    handle.trackGroup(300, EARLY);
    handle.untrackGroup(300);
    expect(readRecord(dir).groups).toEqual([]);
  });

  test("returns true when it removed the group", async () => {
    const handle = await held(privateDir());
    handle.trackGroup(300, EARLY);
    expect(handle.untrackGroup(300)).toBe(true);
  });

  test("keeps a group that still exists", async () => {
    const dir = privateDir();
    const handle = await held(dir, deps({ groupExists: () => true }));
    handle.trackGroup(300, EARLY);
    handle.untrackGroup(300);
    expect(readRecord(dir).groups.map((g) => g.pgid)).toEqual([300]);
  });

  test("returns false for a group that still exists", async () => {
    const handle = await held(privateDir(), deps({ groupExists: () => true }));
    handle.trackGroup(300, EARLY);
    expect(handle.untrackGroup(300)).toBe(false);
  });

  test("returns false and keeps the group when groupExists throws", async () => {
    let failing = false;
    const dir = privateDir();
    const handle = await held(
      dir,
      deps({
        groupExists: () => {
          if (failing) throw new Error("boom");
          return false;
        },
      }),
    );
    handle.trackGroup(300, EARLY);
    failing = true;
    expect(handle.untrackGroup(300)).toBe(false);
  });

  test("returns true for a group that was never tracked", async () => {
    const handle = await held(privateDir());
    expect(handle.untrackGroup(999)).toBe(true);
  });

  test("throws after release", async () => {
    const handle = await held(privateDir());
    handle.release();
    expect(() => handle.untrackGroup(300)).toThrow();
  });
});

describe("release", () => {
  test("clears the holder in the record", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    handle.release();
    expect(readRecord(dir).holder).toBeNull();
  });

  test("keeps the groups that were not untracked", async () => {
    const dir = privateDir();
    const handle = await held(dir, deps({ groupExists: () => true }));
    handle.trackGroup(300, EARLY);
    handle.release();
    expect(readRecord(dir).groups.map((g) => g.pgid)).toEqual([300]);
  });

  test("closes the descriptor even when the record cannot be written", async () => {
    const { io, control } = switchableIo();
    const handle = await held(privateDir(), deps(), io);
    control.mode = "throw";
    handle.release();
    expect(io.openFds()).toBe(0);
  });

  test("does not throw when the record cannot be written", async () => {
    const { io, control } = switchableIo();
    const handle = await held(privateDir(), deps(), io);
    control.mode = "throw";
    expect(() => handle.release()).not.toThrow();
  });
});

describe("failures that the fake kernel lock can inject", () => {
  test("is blocked as io when the first record cannot be written", async () => {
    const { io, control } = switchableIo();
    control.mode = "throw";
    const result = await take(privateDir(), deps(), io);
    expect(result).toEqual({
      kind: "blocked",
      cause: "io",
      reason: "lock owner record cannot be written",
    });
  });

  test("closes the descriptor when the first record cannot be written", async () => {
    const { io, control } = switchableIo();
    control.mode = "throw";
    await take(privateDir(), deps(), io);
    expect(io.openFds()).toBe(0);
  });

  test("is blocked as io for a short write", async () => {
    const { io, control } = switchableIo();
    control.mode = "short";
    const result = await take(privateDir(), deps(), io);
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("trackGroup throws when the record cannot be written", async () => {
    const { io, control } = switchableIo();
    const handle = await held(privateDir(), deps(), io);
    control.mode = "throw";
    expect(() => handle.trackGroup(300, EARLY)).toThrow();
  });

  test("trackGroup leaves the record as it was when the write fails", async () => {
    const dir = privateDir();
    const { io, control } = switchableIo();
    const handle = await held(dir, deps(), io);
    const before = readFileSync(join(dir, "lock"), "utf8");
    control.mode = "throw";
    try {
      handle.trackGroup(300, EARLY);
    } catch {
      // 例外は別のテストで確かめる。
    }
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(before);
  });

  test("trackGroup does not remember a group whose write failed", async () => {
    const { io, control } = switchableIo();
    const handle = await held(privateDir(), deps(), io);
    control.mode = "throw";
    try {
      handle.trackGroup(300, EARLY);
    } catch {
      // 例外は別のテストで確かめる。
    }
    expect(handle.untrackGroup(300)).toBe(true);
  });

  test("untrackGroup returns false when the write fails", async () => {
    const { io, control } = switchableIo();
    const handle = await held(privateDir(), deps(), io);
    handle.trackGroup(300, EARLY);
    control.mode = "throw";
    expect(handle.untrackGroup(300)).toBe(false);
  });

  test("untrackGroup keeps the group in memory when the write fails", async () => {
    const dir = privateDir();
    const { io, control } = switchableIo();
    const handle = await held(dir, deps(), io);
    handle.trackGroup(300, EARLY);
    control.mode = "throw";
    handle.untrackGroup(300);
    control.mode = "ok";
    handle.untrackGroup(300);
    expect(readRecord(dir).groups).toEqual([]);
  });

  test("is blocked as unsafe when the owner of the lock file is another user", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const io = fakeIo({ fileUid: () => uid + 1 });
    const result = await take(dir, deps(), io);
    expect(result).toEqual({
      kind: "blocked",
      cause: "unsafe",
      reason: "lock file is not a safe regular file",
    });
  });

  test("is blocked as unsafe when only the state directory differs", async () => {
    const dir = privateDir();
    emptyLock(dir);
    const io = fakeIo({
      afterOpen: () => {
        renameSync(dir, `${dir}.moved`);
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        renameSync(join(`${dir}.moved`, "lock"), join(dir, "lock"));
      },
    });
    const result = await take(dir, deps(), io);
    expect(result).toEqual({
      kind: "blocked",
      cause: "unsafe",
      reason: "state directory changed while taking the lock",
    });
  });

  test("is blocked as unsafe when the lock file is replaced while orphans are checked", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await take(
      dir,
      deps({
        groupExists: () => true,
        processStart: async () => {
          renameSync(join(dir, "lock"), join(dir, "lock.moved"));
          writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
          return "2026-10-18T12:00:00Z";
        },
      }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test("is blocked as io for a pid that is not a positive integer", async () => {
    const result = await take(privateDir(), deps({ pid: 0 }));
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });

  test("a file of only spaces is not a record", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "lock"), " ".repeat(RECORD_SIZE), { mode: 0o600 });
    const result = await take(dir);
    expect(result.kind === "blocked" && result.cause).toBe("owner_unreadable");
  });

  test("resetOwnerRecord writes nothing when the lock file is replaced while orphans are checked", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await resetOwnerRecordForTest(
      dir,
      deps({
        groupExists: () => true,
        processStart: async () => {
          renameSync(join(dir, "lock"), join(dir, "lock.moved"));
          writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
          return "2026-10-18T12:00:00Z";
        },
      }),
      fakeIo(),
      {},
    );
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });
});

describe("the fence", () => {
  test("does not throw while the lock is held", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    expect(() => handle.lock.assertHeld(dir)).not.toThrow();
  });

  test("throws after release", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    handle.release();
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("throws for another state directory", async () => {
    const handle = await held(privateDir());
    expect(() => handle.lock.assertHeld(privateDir())).toThrow();
  });

  test("accepts the same directory with a trailing slash", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    expect(() => handle.lock.assertHeld(`${dir}/`)).not.toThrow();
  });

  test("throws for a path with a parent element", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    expect(() => handle.lock.assertHeld(`${dir}/../state`)).toThrow();
  });

  test("throws when the lock file was removed", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    rmSync(join(dir, "lock"));
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("throws when the lock file was replaced", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    renameSync(join(dir, "lock"), join(dir, "lock.moved"));
    writeFileSync(join(dir, "lock"), "", { mode: 0o600 });
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("throws when the state directory was replaced", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    renameSync(dir, `${dir}.moved`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("throws when only the state directory was replaced", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    renameSync(dir, `${dir}.moved`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    renameSync(join(`${dir}.moved`, "lock"), join(dir, "lock"));
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("throws when the lock file gained another link", async () => {
    const dir = privateDir();
    const handle = await held(dir);
    linkSync(join(dir, "lock"), join(dir, "lock2"));
    expect(() => handle.lock.assertHeld(dir)).toThrow();
  });

  test("a stale handle does not write into a later holder's record", async () => {
    const dir = privateDir();
    const io = fakeIo();
    const first = await held(dir, deps(), io);
    first.release();
    const second = await held(dir, deps({ pid: 999 }), io);
    try {
      first.trackGroup(300, EARLY);
    } catch {
      // 解放済みなので例外になる。
    }
    expect(readRecord(dir).holder?.pid).toBe(999);
    second.release();
  });
});

describe("resetOwnerRecord with a fake kernel lock", () => {
  async function reset(
    dir: string,
    d: LockDeps = deps(),
    options: { discard?: number[]; create?: boolean } = {},
    io: LockIo = fakeIo(),
  ) {
    return resetOwnerRecordForTest(dir, d, io, options);
  }

  test("is busy while another holder has the lock", async () => {
    const dir = privateDir();
    const io = fakeIo();
    await held(dir, deps(), io);
    expect((await reset(dir, deps(), {}, io)).kind).toBe("busy");
  });

  test("does not change the record while busy", async () => {
    const dir = privateDir();
    const io = fakeIo();
    await held(dir, deps(), io);
    const before = readFileSync(join(dir, "lock"), "utf8");
    await reset(dir, deps(), {}, io);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(before);
  });

  test("clears a record that cannot be read", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "lock"), "x".repeat(RECORD_SIZE), { mode: 0o600 });
    await reset(dir);
    expect(readRecord(dir)).toEqual(rec());
  });

  test("shrinks a file of 1025 bytes to 1024", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "lock"), "x".repeat(RECORD_SIZE + 1), {
      mode: 0o600,
    });
    await reset(dir);
    expect(lockSize(dir)).toBe(RECORD_SIZE);
  });

  test("lets the next acquisition succeed after clearing a broken record", async () => {
    const dir = privateDir();
    writeFileSync(join(dir, "lock"), "x".repeat(RECORD_SIZE), { mode: 0o600 });
    await reset(dir);
    expect((await take(dir)).kind).toBe("held");
  });

  test("refuses to clear a real orphan without discard", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await reset(dir, deps({ groupExists: () => true }));
    expect(result).toEqual({ kind: "orphan_alive", pgids: [5] });
  });

  test("does not write when it refuses", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const before = readFileSync(join(dir, "lock"), "utf8");
    await reset(dir, deps({ groupExists: () => true }));
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(before);
  });

  test("clears a real orphan when discard names exactly it", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await reset(dir, deps({ groupExists: () => true }), {
      discard: [5],
    });
    expect(result.kind).toBe("reset");
  });

  test("refuses when discard names only some of the real orphans", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5), group(6)]));
    const result = await reset(dir, deps({ groupExists: () => true }), {
      discard: [5],
    });
    expect(result.kind).toBe("orphan_alive");
  });

  test("refuses when discard names a group that is not a real orphan", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await reset(dir, deps({ groupExists: () => true }), {
      discard: [5, 6],
    });
    expect(result.kind).toBe("orphan_alive");
  });

  test("clears a record whose groups are all gone without discard", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    await reset(dir, deps({ groupExists: () => false }));
    expect(readRecord(dir).groups).toEqual([]);
  });

  test("clears a record whose groups are only reused pids without discard", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await reset(
      dir,
      deps({
        groupExists: () => true,
        processStart: async () => "2026-10-18T12:00:00Z",
      }),
    );
    expect(result.kind).toBe("reset");
  });

  test("keeps the inode of the lock file", async () => {
    const dir = privateDir();
    seed(dir, rec());
    const before = statSync(join(dir, "lock")).ino;
    await reset(dir);
    expect(statSync(join(dir, "lock")).ino).toBe(before);
  });

  test("lets the next acquisition succeed", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    await reset(dir, deps({ groupExists: () => false }));
    expect((await take(dir)).kind).toBe("held");
  });

  test("releases the lock afterwards", async () => {
    const dir = privateDir();
    seed(dir, rec());
    const io = fakeIo();
    await reset(dir, deps(), {}, io);
    expect(io.openFds()).toBe(0);
  });

  test("does not create the lock file by default", async () => {
    const dir = privateDir();
    const result = await reset(dir);
    expect(result.kind === "blocked" && result.cause).toBe("lock_absent");
  });

  test("creates the lock file when asked to", async () => {
    const dir = privateDir();
    await reset(dir, deps(), { create: true });
    expect(readRecord(dir)).toEqual(rec());
  });

  test("is blocked as unsafe for a lock file open to others", async () => {
    const dir = privateDir();
    seed(dir, rec(), 0o644);
    const result = await reset(dir);
    expect(result.kind === "blocked" && result.cause).toBe("unsafe");
  });

  test.each([
    ["a fractional number", [1.5]],
    ["a duplicate", [5, 5]],
    ["nine entries", [2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ["a pgid below two", [1]],
  ])("rejects a discard list with %s", async (_name, discard) => {
    const dir = privateDir();
    seed(dir, rec());
    await expect(reset(dir, deps(), { discard })).rejects.toThrow();
  });

  test("is blocked as io when processStart returns a malformed time", async () => {
    const dir = privateDir();
    seed(dir, rec([group(5)]));
    const result = await reset(
      dir,
      deps({ groupExists: () => true, processStart: async () => "yesterday" }),
    );
    expect(result.kind === "blocked" && result.cause).toBe("io");
  });
});

describe.skipIf(!REAL)("with the kernel lock (darwin)", () => {
  test("only one of two acquisitions holds the lock", async () => {
    const dir = privateDir();
    const first = await acquireLock(dir, deps(), { create: true });
    const second = await acquireLock(dir, deps(), { create: true });
    if (first.kind === "held") opened.push(first.handle);
    if (second.kind === "held") opened.push(second.handle);
    expect([first.kind, second.kind]).toEqual(["held", "busy"]);
  });

  test("passes its own self check", async () => {
    const result = await acquireLock(privateDir(), deps(), { create: true });
    if (result.kind === "held") opened.push(result.handle);
    expect(result.kind).toBe("held");
  });

  test("can be taken again after release", async () => {
    const dir = privateDir();
    const first = await acquireLock(dir, deps(), { create: true });
    if (first.kind === "held") first.handle.release();
    const second = await acquireLock(dir, deps());
    if (second.kind === "held") opened.push(second.handle);
    expect(second.kind).toBe("held");
  });

  test("fstat with bigint works on the held descriptor", async () => {
    const dir = privateDir();
    const fd = openSync(
      join(dir, "probe"),
      constants.O_RDWR | constants.O_CREAT,
      0o600,
    );
    const stat = fstatSync(fd, { bigint: true });
    closeSync(fd);
    expect(typeof stat.ino).toBe("bigint");
  });

  test("resetOwnerRecord is busy while the lock is held", async () => {
    const dir = privateDir();
    const first = await acquireLock(dir, deps(), { create: true });
    if (first.kind === "held") opened.push(first.handle);
    const result = await resetOwnerRecord(dir, deps());
    expect(result.kind).toBe("busy");
  });

  test("opening and closing the lock file read-only does not drop the hold", async () => {
    const dir = privateDir();
    const first = await acquireLock(dir, deps({ pid: 31337 }), {
      create: true,
    });
    if (first.kind === "held") opened.push(first.handle);
    const probe = openSync(join(dir, "lock"), constants.O_RDONLY);
    closeSync(probe);
    const second = await acquireLock(dir, deps());
    expect(second.kind).toBe("busy");
  });

  test("a child process does not inherit the lock", async () => {
    const dir = privateDir();
    const first = await acquireLock(dir, deps(), { create: true });
    if (first.kind !== "held") throw new Error("not held");
    const child = Bun.spawn(["/bin/sleep", "30"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    first.handle.release();
    const second = await acquireLock(dir, deps());
    if (second.kind === "held") opened.push(second.handle);
    process.kill(-child.pid, "SIGKILL");
    await child.exited;
    expect(second.kind).toBe("held");
  });

  describe("with a real process group", () => {
    const groups: number[] = [];
    afterEach(() => {
      for (const pgid of groups.splice(0)) {
        try {
          defaultKillGroup(pgid);
        } catch {
          // すでに終わっている。
        }
      }
    });

    const run = createRunner();
    const stamp = () => `${new Date().toISOString().slice(0, 19)}Z`;
    const real = (): LockDeps =>
      deps({
        now: stamp,
        groupExists: (pgid) => {
          try {
            process.kill(-pgid, 0);
            return true;
          } catch (error) {
            return !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ESRCH"
            );
          }
        },
        processStart: (pgid) => processStart(run, pgid),
      });

    function startChild(): { pgid: number; before: string; to: string } {
      const before = stamp();
      const child = Bun.spawn(["/bin/sleep", "30"], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      groups.push(child.pid);
      return { pgid: child.pid, before, to: stamp() };
    }

    test("the start time of a detached child falls inside the recorded interval", async () => {
      const child = startChild();
      const start = await processStart(run, child.pgid);
      const at = Math.floor(Date.parse(start ?? "") / 1000);
      expect(
        at >= Math.floor(Date.parse(child.before) / 1000) - 1 &&
          at <= Math.floor(Date.parse(child.to) / 1000) + 1,
      ).toBe(true);
    });

    test("a live recorded group stops the next acquisition", async () => {
      const dir = privateDir();
      const child = startChild();
      seed(dir, rec([group(child.pgid, child.before, child.to)]));
      const result = await acquireLock(dir, real(), { create: true });
      expect(result).toEqual({ kind: "orphan_alive", pgids: [child.pgid] });
    });

    test("the group is gone after the child is killed and reaped", () => {
      const child = startChild();
      defaultKillGroup(child.pgid);
      return Bun.sleep(300).then(() => {
        expect(() => process.kill(-child.pgid, 0)).toThrow("ESRCH");
      });
    });

    test("the next acquisition succeeds after the recorded group is gone", async () => {
      const dir = privateDir();
      const child = startChild();
      seed(dir, rec([group(child.pgid, child.before, child.to)]));
      defaultKillGroup(child.pgid);
      await Bun.sleep(300);
      const result = await acquireLock(dir, real(), { create: true });
      if (result.kind === "held") opened.push(result.handle);
      expect(result.kind).toBe("held");
    });
  });

  test("a holder killed with SIGKILL releases the lock", async () => {
    const dir = privateDir();
    const script = join(dir, "hold.ts");
    writeFileSync(
      script,
      [
        'import { openSync } from "node:fs";',
        `openSync(${JSON.stringify(join(dir, "lock"))}, 2 | 512 | 0x20 | 4, 0o600);`,
        'console.log("held");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    await reader.read();
    const while_ = await acquireLock(dir, deps(), { create: true });
    child.kill("SIGKILL");
    await child.exited;
    const after = await acquireLock(dir, deps(), { create: true });
    if (after.kind === "held") opened.push(after.handle);
    expect([while_.kind, after.kind]).toEqual(["busy", "held"]);
  });
});

describe.skipIf(process.platform !== "linux")("on Linux", () => {
  test("the default open is not a kernel lock, so acquisition is unsupported", async () => {
    const result = await acquireLock(privateDir(), deps(), { create: true });
    expect(result.kind === "blocked" && result.cause).toBe("unsupported");
  });
});
