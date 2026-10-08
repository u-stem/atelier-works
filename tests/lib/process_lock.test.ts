import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  FLOCK_PATH,
  formatLockHolders,
  hasFlockLine,
  isStoppableBy,
  LOCK_OWNER_ENV,
  LOCK_PATH_ENV,
  type LockOwner,
  type LockProcess,
  type LockReleaseDeps,
  lockJobIdFromEnv,
  lockPathFromEnviron,
  type OrphanLockFileDeps,
  ownerFromEnviron,
  type ProcFs,
  type ProcStat,
  parseLockOwner,
  parseProcStat,
  planLockRelease,
  probeWorktreeLock,
  RM_PATH,
  removeLockFileArgv,
  removeLockFileUnderLock,
  removeOrphanLockFiles,
  type SignalDeps,
  scanLockProcesses,
  stopProcesses,
  TRUE_PATH,
  WORKTREE_BUSY_REASON,
  WORKTREE_LOCK_BUSY_EXIT_CODE,
  WorktreeBusyError,
  type WorktreeLock,
  WorktreeLockHeldInRunError,
  withWorktreeProcessLock,
  worktreeLockFor,
  worktreeNameOfLockFile,
} from "../../f/factory/lib/process_lock.ts";
import { runCommand } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, ok } from "./testSupport.ts";

const DIR = "/workspaces/acme/widgets/factory-issue-7-wi-3";
const LOCK = worktreeLockFor(DIR, (path) => path);
const LOCK_ID = "8:42";
const OTHER_JOB: LockOwner = {
  kind: "implement",
  workItemId: 3,
  jobId: "job-a",
};
const THIS_JOB: LockOwner = {
  kind: "implement",
  workItemId: 3,
  jobId: "job-b",
};
const PR_FIX: LockOwner = { kind: "pr_fix", workItemId: 9, jobId: "job-c" };
const FLOCK_LINE =
  "pos:\t0\nflags:\t02\nlock:\t1: FLOCK  ADVISORY  WRITE 10 08:01:42 0 EOF\n";

/** 終了コード213で出力が空の結果(ロックが塞がっていた)。 */
const busy = () => fail("", WORKTREE_LOCK_BUSY_EXIT_CODE);
const busyTimes = (n: number) => Array.from({ length: n }, busy);

/** /proc/<pid>/statの1行。starttimeは先頭から22番目の欄。 */
function statLine(
  pid: number,
  ppid: number,
  pgid: number,
  start: number,
): string {
  return `${String(pid)} (x y) S ${String(ppid)} ${String(pgid)} ${String(pgid)} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${String(start)} 0 0`;
}

function entry(overrides: Partial<LockProcess> = {}): LockProcess {
  return {
    pid: 42,
    ppid: 1,
    pgid: 42,
    startTime: "50000",
    elapsedSec: 3600,
    command: "claude -p --x",
    owner: OTHER_JOB,
    lockPath: LOCK.lockPath,
    holdsLock: true,
    uninspectable: false,
    ...overrides,
  };
}

type FakeProc = {
  readonly stat: string;
  readonly environ?: string;
  readonly cmdline?: string;
  readonly fds?: Record<
    string,
    { readonly id: string; readonly fdinfo?: string }
  >;
};

/** Nodeのfsが投げるのと同じ形(`code`を持つ)の例外。 */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** pidごとの内容を持つ偽の/proc。ロックファイルのdev/inoはLOCK_ID。 */
function fakeProcFs(procs: Record<string, FakeProc>): ProcFs {
  const proc = (path: string): FakeProc => {
    const found = procs[path.split("/")[2] ?? ""];
    if (found === undefined) throw errno("ENOENT");
    return found;
  };
  return {
    readdir: async (path) => {
      if (path === "/proc") return [...Object.keys(procs), "self", "uptime"];
      return Object.keys(proc(path).fds ?? {});
    },
    readText: async (path) => {
      if (path === "/proc/uptime") return "1000.00 0.00\n";
      const p = proc(path);
      const [, , , kind = "", fd = ""] = path.split("/");
      if (kind === "stat") return p.stat;
      if (kind === "environ") return p.environ ?? "";
      if (kind === "cmdline") return p.cmdline ?? "";
      const info = p.fds?.[fd]?.fdinfo;
      if (kind === "fdinfo" && info !== undefined) return info;
      throw errno("ENOENT");
    },
    fileId: async (path) => {
      if (path === LOCK.lockPath) return LOCK_ID;
      const [, , , , fd = ""] = path.split("/");
      const id = proc(path).fds?.[fd]?.id;
      if (id === undefined) throw errno("ENOENT");
      return id;
    },
  };
}

/** 自分(900)と親(800)。どちらも除外される。 */
const SELF_PROCS: Record<string, FakeProc> = {
  "900": { stat: statLine(900, 800, 900, 1) },
  "800": { stat: statLine(800, 1, 800, 1) },
};

type DepsCalls = {
  scans: number;
  stopped: (readonly LockProcess[])[];
  rechecks: number;
};

/** 走査ごとに`scans`を順に返し(最後の結果を返し続ける)、停止と確かめ直しを記録する依存。 */
function fakeDeps(scans: readonly (readonly LockProcess[])[]): {
  deps: LockReleaseDeps;
  calls: DepsCalls;
} {
  const calls: DepsCalls = { scans: 0, stopped: [], rechecks: 0 };
  return {
    calls,
    deps: {
      scan: async () => {
        const result = scans[Math.min(calls.scans, scans.length - 1)] ?? [];
        calls.scans += 1;
        return result;
      },
      stop: async (targets) => {
        calls.stopped.push(targets);
      },
      sleep: async () => {},
    },
  };
}

function policy(calls: DepsCalls, self: LockOwner = THIS_JOB) {
  return {
    self,
    recheck: async () => {
      calls.rechecks += 1;
    },
  };
}

describe("worktreeLockFor", () => {
  test("puts the lock next to the worktree under the real parent", () => {
    expect(worktreeLockFor("/w/repo/wt", () => "/real/repo").lockPath).toBe(
      "/real/repo/.wt.process.lock",
    );
  });

  test("refuses a path that is not normalized", () => {
    expect(() => worktreeLockFor("/w/repo/../wt", (path) => path)).toThrow();
  });

  test("refuses a relative path", () => {
    expect(() => worktreeLockFor("repo/wt", (path) => path)).toThrow();
  });

  test("refuses the root directory", () => {
    expect(() => worktreeLockFor("/", (path) => path)).toThrow();
  });

  test("refuses a directory whose name starts with a dot", () => {
    expect(() => worktreeLockFor("/w/repo/.wt", (path) => path)).toThrow();
  });
});

describe("parseLockOwner", () => {
  test("parses an implement owner", () => {
    expect(parseLockOwner("implement:3:job-a")).toEqual(OTHER_JOB);
  });

  test("rejects an unknown kind", () => {
    expect(parseLockOwner("review:3:job-a")).toBeNull();
  });

  test("rejects a missing job id", () => {
    expect(parseLockOwner("implement:3:")).toBeNull();
  });
});

describe("lockJobIdFromEnv", () => {
  test("uses the root flow job id", () => {
    expect(lockJobIdFromEnv({ WM_ROOT_FLOW_JOB_ID: "0190-ab" })).toBe(
      "0190-ab",
    );
  });

  test("falls back to unknown without one", () => {
    expect(lockJobIdFromEnv({})).toBe("unknown");
  });
});

describe("parseProcStat", () => {
  test("reads the state", () => {
    expect(parseProcStat(statLine(42, 1, 40, 777))?.state).toBe("S");
  });

  test("reads the process group", () => {
    expect(parseProcStat(statLine(42, 1, 40, 777))?.pgid).toBe(40);
  });

  test("reads the start time", () => {
    expect(parseProcStat(statLine(42, 1, 40, 777))?.startTime).toBe("777");
  });

  test("reads past a command name containing parentheses", () => {
    expect(
      parseProcStat(statLine(42, 7, 40, 777).replace("(x y)", "(a) b)"))?.ppid,
    ).toBe(7);
  });

  test("returns null for a broken line", () => {
    expect(parseProcStat("42 x")).toBeNull();
  });
});

describe("ownerFromEnviron", () => {
  test("finds the owner among the variables", () => {
    expect(
      ownerFromEnviron(
        `HOME=/root\0${LOCK_OWNER_ENV}=implement:3:job-a\0PATH=/bin\0`,
      ),
    ).toEqual(OTHER_JOB);
  });

  test("returns null without the variable", () => {
    expect(ownerFromEnviron("HOME=/root\0")).toBeNull();
  });
});

describe("lockPathFromEnviron", () => {
  test("finds the lock file the process was started under", () => {
    expect(
      lockPathFromEnviron(`HOME=/root\0${LOCK_PATH_ENV}=${LOCK.lockPath}\0`),
    ).toBe(LOCK.lockPath);
  });

  test("returns null without the variable", () => {
    expect(lockPathFromEnviron("HOME=/root\0")).toBeNull();
  });
});

describe("hasFlockLine", () => {
  test("finds a FLOCK lock line", () => {
    expect(hasFlockLine(FLOCK_LINE)).toBe(true);
  });

  test("ignores fdinfo without a lock", () => {
    expect(hasFlockLine("pos:\t0\nflags:\t02\n")).toBe(false);
  });
});

describe("probeWorktreeLock", () => {
  test("tries the lock without waiting by running true under it", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await probeWorktreeLock({ run: fake.run, lock: LOCK });
    expect(fake.calls[0]?.argv).toEqual([
      FLOCK_PATH,
      "--nonblock",
      "--conflict-exit-code",
      String(WORKTREE_LOCK_BUSY_EXIT_CODE),
      LOCK.lockPath,
      TRUE_PATH,
    ]);
  });

  test("reports free when flock exits 0", async () => {
    const fake = createFakeCommandRunner([ok()]);
    expect(await probeWorktreeLock({ run: fake.run, lock: LOCK })).toBe("free");
  });

  test("reports held on the conflict code with no output", async () => {
    const fake = createFakeCommandRunner([busy()]);
    expect(await probeWorktreeLock({ run: fake.run, lock: LOCK })).toBe("held");
  });

  test("throws when flock itself fails", async () => {
    const fake = createFakeCommandRunner([
      fail("flock: cannot open lock file", 1),
    ]);
    await expect(
      probeWorktreeLock({ run: fake.run, lock: LOCK }),
    ).rejects.toThrow("flock");
  });

  test("does not read the conflict code with output as held", async () => {
    const fake = createFakeCommandRunner([
      fail("unexpected", WORKTREE_LOCK_BUSY_EXIT_CODE),
    ]);
    await expect(
      probeWorktreeLock({ run: fake.run, lock: LOCK }),
    ).rejects.toThrow("flock");
  });
});

describe("withWorktreeProcessLock", () => {
  test("runs the command as a child of flock that waits briefly for the lock", async () => {
    const fake = createFakeCommandRunner([ok("out")]);
    await withWorktreeProcessLock(
      fake.run,
      LOCK,
      OTHER_JOB,
    )(["claude", "-p"], { cwd: DIR });
    expect(fake.calls[0]?.argv).toEqual([
      FLOCK_PATH,
      "--wait",
      "5",
      "--conflict-exit-code",
      String(WORKTREE_LOCK_BUSY_EXIT_CODE),
      LOCK.lockPath,
      "claude",
      "-p",
    ]);
  });

  test("tags the command with its owner", async () => {
    const fake = createFakeCommandRunner([ok("out")]);
    await withWorktreeProcessLock(
      fake.run,
      LOCK,
      OTHER_JOB,
    )(["claude", "-p"], { env: { HOME: "/h" } });
    expect(fake.calls[0]?.options?.env?.[LOCK_OWNER_ENV]).toBe(
      "implement:3:job-a",
    );
  });

  test("tags the command with its lock file", async () => {
    const fake = createFakeCommandRunner([ok("out")]);
    await withWorktreeProcessLock(fake.run, LOCK, OTHER_JOB)(["claude", "-p"]);
    expect(fake.calls[0]?.options?.env?.[LOCK_PATH_ENV]).toBe(LOCK.lockPath);
  });

  test("keeps the environment the caller passed", async () => {
    const fake = createFakeCommandRunner([ok("out")]);
    await withWorktreeProcessLock(
      fake.run,
      LOCK,
      OTHER_JOB,
    )(["claude", "-p"], { env: { HOME: "/h" } });
    expect(fake.calls[0]?.options?.env?.HOME).toBe("/h");
  });

  test("passes the other run options through", async () => {
    const fake = createFakeCommandRunner([ok("out")]);
    await withWorktreeProcessLock(
      fake.run,
      LOCK,
      OTHER_JOB,
    )(["claude", "-p"], { cwd: DIR });
    expect(fake.calls[0]?.options?.cwd).toBe(DIR);
  });

  test("throws WorktreeLockHeldInRunError when the lock stays held", async () => {
    const fake = createFakeCommandRunner([busy()]);
    await expect(
      withWorktreeProcessLock(fake.run, LOCK, OTHER_JOB)(["claude", "-p"]),
    ).rejects.toBeInstanceOf(WorktreeLockHeldInRunError);
  });

  test("refuses an empty argv", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      withWorktreeProcessLock(fake.run, LOCK, OTHER_JOB)([]),
    ).rejects.toThrow("locked command must not be empty");
  });

  test("refuses an empty command name", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      withWorktreeProcessLock(fake.run, LOCK, OTHER_JOB)(["", "x"]),
    ).rejects.toThrow("locked command must not be empty");
  });

  // flockは、ロックファイルの次の引数が`-c`などのオプションならコマンドとして扱わず、シェルで実行しうる。
  test("refuses a command that starts with a dash", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      withWorktreeProcessLock(fake.run, LOCK, OTHER_JOB)(["-c", "id"]),
    ).rejects.toThrow("locked command must not start with '-': -c");
  });

  test("does not run flock for a command that starts with a dash", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await withWorktreeProcessLock(
      fake.run,
      LOCK,
      OTHER_JOB,
    )(["-c", "id"]).catch(() => undefined);
    expect(fake.calls).toHaveLength(0);
  });

  test("returns a command's own 213 with output as its result", async () => {
    const fake = createFakeCommandRunner([
      fail("boom", WORKTREE_LOCK_BUSY_EXIT_CODE),
    ]);
    expect(
      (
        await withWorktreeProcessLock(
          fake.run,
          LOCK,
          OTHER_JOB,
        )(["bun", "test"])
      ).stderr,
    ).toBe("boom");
  });
});

describe("scanLockProcesses", () => {
  const scan = (procs: Record<string, FakeProc>) =>
    scanLockProcesses(LOCK, fakeProcFs({ ...SELF_PROCS, ...procs }), 900);

  test("finds a process holding a FLOCK on the lock file", async () => {
    const entries = await scan({
      "10": {
        stat: statLine(10, 1, 10, 1),
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries.map((found) => found.pid)).toEqual([10]);
  });

  test("does not count an open fd without a FLOCK line", async () => {
    const entries = await scan({
      "11": {
        stat: statLine(11, 1, 11, 1),
        fds: { "3": { id: LOCK_ID, fdinfo: "pos:\t0\n" } },
      },
    });
    expect(entries).toHaveLength(0);
  });

  test("does not count a FLOCK on another file", async () => {
    const entries = await scan({
      "12": {
        stat: statLine(12, 1, 12, 1),
        fds: { "3": { id: "8:43", fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries).toHaveLength(0);
  });

  test("keeps a tagged process that closed the lock fd", async () => {
    const entries = await scan({
      "13": {
        stat: statLine(13, 10, 10, 1),
        environ: `${LOCK_OWNER_ENV}=implement:3:job-a\0`,
      },
    });
    expect(entries[0]?.holdsLock).toBe(false);
  });

  test("reads the owner tag of a holder", async () => {
    const entries = await scan({
      "10": {
        stat: statLine(10, 1, 10, 1),
        environ: `${LOCK_OWNER_ENV}=implement:3:job-a\0`,
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries[0]?.owner).toEqual(OTHER_JOB);
  });

  test("computes the elapsed seconds from the start time", async () => {
    const entries = await scan({
      "10": {
        stat: statLine(10, 1, 10, 50_000),
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries[0]?.elapsedSec).toBe(500);
  });

  test("joins the command line", async () => {
    const entries = await scan({
      "10": {
        stat: statLine(10, 1, 10, 1),
        cmdline: "claude\0-p\0",
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries[0]?.command).toBe("claude -p");
  });

  test("skips its own ancestors", async () => {
    const entries = await scan({
      "800": {
        stat: statLine(800, 1, 800, 1),
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries).toHaveLength(0);
  });

  test("skips pid 1", async () => {
    const entries = await scan({
      "1": {
        stat: statLine(1, 0, 1, 1),
        fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
      },
    });
    expect(entries).toHaveLength(0);
  });

  test("skips a zombie", async () => {
    const entries = await scan({
      "10": {
        stat: statLine(10, 1, 10, 1).replace(" S ", " Z "),
        environ: `${LOCK_OWNER_ENV}=implement:3:job-a\0`,
      },
    });
    expect(entries).toHaveLength(0);
  });

  test("reads the lock file tag of a process", async () => {
    const entries = await scan({
      "13": {
        stat: statLine(13, 1, 13, 1),
        environ: `${LOCK_PATH_ENV}=${LOCK.lockPath}\0`,
      },
    });
    expect(entries[0]?.lockPath).toBe(LOCK.lockPath);
  });

  test("still finds tagged processes when the lock file is gone", async () => {
    const missing = worktreeLockFor("/nowhere/wt", (path) => path);
    const fs = fakeProcFs({
      ...SELF_PROCS,
      "13": {
        stat: statLine(13, 1, 13, 1),
        environ: `${LOCK_PATH_ENV}=${missing.lockPath}\0`,
      },
    });
    expect(
      (await scanLockProcesses(missing, fs, 900)).map((found) => found.pid),
    ).toEqual([13]);
  });

  test("returns nothing when the lock file does not exist", async () => {
    const fs = fakeProcFs(SELF_PROCS);
    const missing = worktreeLockFor("/nowhere/wt", (path) => path);
    expect(await scanLockProcesses(missing, fs, 900)).toEqual([]);
  });
});

describe("planLockRelease", () => {
  const OTHER_LOCK = "/w/repo/.other.process.lock";

  test("is busy for a process that could not be inspected even when nothing holds the lock", () => {
    const plan = planLockRelease(
      [
        entry({
          owner: null,
          lockPath: null,
          holdsLock: false,
          uninspectable: true,
        }),
      ],
      LOCK,
      THIS_JOB,
    );
    expect(plan.kind).toBe("busy");
  });

  test("stops holders from another job of the same work item", () => {
    expect(planLockRelease([entry()], LOCK, THIS_JOB).kind).toBe("stop");
  });

  test("includes tagged processes of this lock that closed the lock fd", () => {
    const plan = planLockRelease(
      [entry(), entry({ pid: 43, holdsLock: false })],
      LOCK,
      THIS_JOB,
    );
    expect(
      plan.kind === "stop" ? plan.targets.map((target) => target.pid) : [],
    ).toEqual([42, 43]);
  });

  test("is busy when a holder has no owner tag", () => {
    expect(
      planLockRelease(
        [entry(), entry({ pid: 43, owner: null })],
        LOCK,
        THIS_JOB,
      ).kind,
    ).toBe("busy");
  });

  test("is busy when a holder belongs to pr_fix", () => {
    expect(
      planLockRelease([entry({ owner: PR_FIX })], LOCK, THIS_JOB).kind,
    ).toBe("busy");
  });

  test("is busy when a holder belongs to another work item", () => {
    expect(
      planLockRelease([entry()], LOCK, { ...THIS_JOB, workItemId: 4 }).kind,
    ).toBe("busy");
  });

  test("is busy when a holder belongs to this very job", () => {
    expect(
      planLockRelease([entry({ owner: THIS_JOB })], LOCK, THIS_JOB).kind,
    ).toBe("busy");
  });

  test("is busy for any holder when stopping is not allowed", () => {
    expect(planLockRelease([entry()], LOCK, null).kind).toBe("busy");
  });

  test("is busy for a pr_fix leftover tagged with this lock even when nothing holds it", () => {
    expect(
      planLockRelease(
        [entry({ owner: PR_FIX, holdsLock: false })],
        LOCK,
        THIS_JOB,
      ).kind,
    ).toBe("busy");
  });

  test("is busy for a leftover tagged with this lock when stopping is not allowed", () => {
    expect(
      planLockRelease([entry({ holdsLock: false })], LOCK, null).kind,
    ).toBe("busy");
  });

  test("lists the leftover that makes it busy", () => {
    const plan = planLockRelease(
      [entry({ pid: 43, owner: PR_FIX, holdsLock: false })],
      LOCK,
      THIS_JOB,
    );
    expect(
      plan.kind === "busy" ? plan.holders.map((holder) => holder.pid) : [],
    ).toEqual([43]);
  });

  test("ignores a leftover tagged with another lock", () => {
    expect(
      planLockRelease(
        [entry({ owner: PR_FIX, holdsLock: false, lockPath: OTHER_LOCK })],
        LOCK,
        THIS_JOB,
      ).kind,
    ).toBe("none");
  });

  test("does not stop a leftover of this work item tagged with another lock", () => {
    expect(
      planLockRelease(
        [entry({ holdsLock: false, lockPath: OTHER_LOCK })],
        LOCK,
        THIS_JOB,
      ).kind,
    ).toBe("none");
  });
});

describe("isStoppableBy", () => {
  test("refuses a missing owner", () => {
    expect(isStoppableBy(null, THIS_JOB)).toBe(false);
  });

  test("refuses an owner whose job id is unknown", () => {
    expect(isStoppableBy({ ...OTHER_JOB, jobId: "unknown" }, THIS_JOB)).toBe(
      false,
    );
  });

  test("refuses to stop for a self whose job id is unknown", () => {
    expect(isStoppableBy(OTHER_JOB, { ...THIS_JOB, jobId: "unknown" })).toBe(
      false,
    );
  });
});

describe("formatLockHolders", () => {
  test("lists the pid, elapsed seconds, owner and command", () => {
    expect(formatLockHolders([entry()])).toBe(
      "pid 42 (3600s, implement:3:job-a) `claude -p --x`",
    );
  });

  test("names a holder without an owner tag", () => {
    expect(formatLockHolders([entry({ owner: null })])).toBe(
      "pid 42 (3600s, no owner) `claude -p --x`",
    );
  });

  test("says when a holder could not be inspected", () => {
    expect(
      formatLockHolders([
        entry({ owner: null, lockPath: null, uninspectable: true }),
      ]),
    ).toBe("pid 42 (3600s, could not be inspected) `claude -p --x`");
  });

  test("masks secrets in the command", () => {
    const token = `sk-ant-${"x".repeat(20)}`;
    expect(
      formatLockHolders([entry({ command: `claude --token ${token}` })]),
    ).not.toContain(token);
  });

  test("turns control characters in the command into single spaces", () => {
    expect(formatLockHolders([entry({ command: "a\r\nb\tc\u0001d" })])).toBe(
      "pid 42 (3600s, implement:3:job-a) `a b c d`",
    );
  });

  test("turns other control, format and line separator characters into single spaces", () => {
    expect(
      formatLockHolders([
        entry({
          command: "a\u007fb\u0085c\u200bd\u202ee\u2066f\u2028g\u2029h",
        }),
      ]),
    ).toBe("pid 42 (3600s, implement:3:job-a) `a b c d e f g h`");
  });

  test("keeps a command from looking like another holder", () => {
    expect(
      formatLockHolders([
        entry({ command: "sleep 1, pid 1 (0s, implement:3:job-b) `true`" }),
      ]),
    ).not.toContain(", pid ");
  });

  test("keeps a command with a semicolon from looking like another holder", () => {
    expect(
      formatLockHolders([entry({ command: "sleep 1;  PID 1 (0s, x)" })]),
    ).not.toMatch(/,\s*pid\s/i);
  });

  test("shows only the command run under the lock", () => {
    expect(
      formatLockHolders([
        entry({
          command: `${FLOCK_PATH} --wait 5 --conflict-exit-code ${String(WORKTREE_LOCK_BUSY_EXIT_CODE)} ${LOCK.lockPath} claude -p --x`,
        }),
      ]),
    ).toBe("pid 42 (3600s, implement:3:job-a) `claude -p --x`");
  });

  test("cuts a long command", () => {
    expect(
      formatLockHolders([entry({ command: "a".repeat(500) })]).length,
    ).toBeLessThan(260);
  });

  test("does not leave a semicolon that describeReason would split on", () => {
    expect(formatLockHolders([entry({ command: "sh -c a; b" })])).not.toContain(
      ";",
    );
  });

  test("keeps a backtick from closing the quoted command", () => {
    expect(formatLockHolders([entry({ command: "echo `id`" })])).toContain(
      "`echo 'id'`",
    );
  });

  test("shows five holders and counts the rest", () => {
    const holders = Array.from({ length: 7 }, (_, i) =>
      entry({ pid: 100 + i }),
    );
    expect(formatLockHolders(holders).endsWith(", +2 more")).toBe(true);
  });
});

describe("WorktreeBusyError", () => {
  test("carries the holders in its message", () => {
    expect(new WorktreeBusyError([entry()]).message).toBe(
      `${WORKTREE_BUSY_REASON}: pid 42 (3600s, implement:3:job-a) \`claude -p --x\``,
    );
  });

  test("uses the bare reason without holders", () => {
    expect(new WorktreeBusyError([]).message).toBe(WORKTREE_BUSY_REASON);
  });
});

describe("stopProcesses", () => {
  type Sent = { pid: number; signal: string };

  function signalDeps(
    stats: Map<number, ProcStat>,
    goneAfterTerm: boolean,
  ): { deps: SignalDeps; sent: Sent[] } {
    const sent: Sent[] = [];
    return {
      sent,
      deps: {
        kill: (pid, signal) => {
          sent.push({ pid, signal });
          if (goneAfterTerm && signal === "SIGTERM" && pid > 0)
            stats.delete(pid);
        },
        readStat: async (pid) => stats.get(pid) ?? null,
        sleep: async () => {},
      },
    };
  }

  const stat = (pid: number, start: string, state = "S"): ProcStat => ({
    state,
    ppid: 1,
    pgid: pid,
    startTime: start,
  });

  test("sends SIGTERM to the process recorded at the scan", async () => {
    const { deps, sent } = signalDeps(new Map([[42, stat(42, "50000")]]), true);
    await stopProcesses([entry({ pgid: 7 })], deps, 300);
    expect(sent).toEqual([{ pid: 42, signal: "SIGTERM" }]);
  });

  test("also signals the group of a group leader", async () => {
    const { deps, sent } = signalDeps(new Map([[42, stat(42, "50000")]]), true);
    await stopProcesses([entry()], deps, 300);
    expect(sent).toContainEqual({ pid: -42, signal: "SIGTERM" });
  });

  test("skips a pid that now belongs to another process", async () => {
    const { deps, sent } = signalDeps(new Map([[42, stat(42, "99999")]]), true);
    await stopProcesses([entry()], deps, 300);
    expect(sent).toHaveLength(0);
  });

  test("does not signal a zombie", async () => {
    const { deps, sent } = signalDeps(
      new Map([[42, stat(42, "50000", "Z")]]),
      false,
    );
    await stopProcesses([entry()], deps, 300);
    expect(sent).toHaveLength(0);
  });

  test("sends SIGKILL to a process still running after the grace", async () => {
    const { deps, sent } = signalDeps(
      new Map([[42, stat(42, "50000")]]),
      false,
    );
    await stopProcesses([entry({ pgid: 7 })], deps, 300);
    expect(sent).toContainEqual({ pid: 42, signal: "SIGKILL" });
  });

  test("does not send SIGKILL once the process is gone", async () => {
    const { deps, sent } = signalDeps(new Map([[42, stat(42, "50000")]]), true);
    await stopProcesses([entry({ pgid: 7 })], deps, 300);
    expect(sent.some((item) => item.signal === "SIGKILL")).toBe(false);
  });

  test("never signals pid 1", async () => {
    const { deps, sent } = signalDeps(new Map([[1, stat(1, "50000")]]), false);
    await stopProcesses([entry({ pid: 1, pgid: 1 })], deps, 300);
    expect(sent).toHaveLength(0);
  });
});

describe("ensureWorktreeLockFree", () => {
  test("scans even when the lock is free and stopping is not allowed", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const { deps, calls } = fakeDeps([[]]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: null,
      deps,
    });
    expect(calls.scans).toBe(1);
  });

  test("retries a held probe before deciding", async () => {
    const fake = createFakeCommandRunner([busy(), ok()]);
    const { deps } = fakeDeps([[]]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: null,
      deps,
    });
    expect(fake.calls).toHaveLength(2);
  });

  test("is busy for a tagged leftover of this lock even when the lock is free", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const { deps } = fakeDeps([[entry({ holdsLock: false })]]);
    await expect(
      ensureWorktreeLockFree({ run: fake.run, lock: LOCK, policy: null, deps }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("names the holders when stopping is not allowed", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const { deps } = fakeDeps([[entry()]]);
    await expect(
      ensureWorktreeLockFree({ run: fake.run, lock: LOCK, policy: null, deps }),
    ).rejects.toThrow("pid 42");
  });

  test("rechecks before stopping", async () => {
    const fake = createFakeCommandRunner([...busyTimes(4), ok()]);
    const { deps, calls } = fakeDeps([[entry()], []]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: policy(calls),
      deps,
    });
    expect(calls.rechecks).toBe(1);
  });

  test("stops the holders from another job of the same work item", async () => {
    const fake = createFakeCommandRunner([...busyTimes(4), ok()]);
    const { deps, calls } = fakeDeps([[entry()], []]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: policy(calls),
      deps,
    });
    expect(calls.stopped).toEqual([[entry()]]);
  });

  test("returns the processes it stopped once nothing is left", async () => {
    const fake = createFakeCommandRunner([...busyTimes(4), ok()]);
    const { deps, calls } = fakeDeps([[entry()], []]);
    expect(
      await ensureWorktreeLockFree({
        run: fake.run,
        lock: LOCK,
        policy: policy(calls),
        deps,
      }),
    ).toEqual([entry()]);
  });

  test("stops again a tagged process that survived the first stop", async () => {
    const fake = createFakeCommandRunner([...busyTimes(4), ok(), ok()]);
    const { deps, calls } = fakeDeps([
      [entry()],
      [entry({ pid: 43, holdsLock: false })],
      [],
    ]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: policy(calls),
      deps,
    });
    expect(calls.stopped).toHaveLength(2);
  });

  test("throws WorktreeBusyError when a tagged process survives every stop", async () => {
    const fake = createFakeCommandRunner([...busyTimes(4), ok(), ok(), ok()]);
    const { deps, calls } = fakeDeps([
      [entry()],
      [entry({ pid: 43, holdsLock: false })],
    ]);
    await expect(
      ensureWorktreeLockFree({
        run: fake.run,
        lock: LOCK,
        policy: policy(calls),
        deps,
      }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("does not stop anything when the recheck fails", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const { deps, calls } = fakeDeps([[entry()]]);
    const failing = {
      self: THIS_JOB,
      recheck: async () => {
        throw new Error("lease lost");
      },
    };
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: failing,
      deps,
    }).catch(() => undefined);
    expect(calls.stopped).toHaveLength(0);
  });

  test("does not stop a holder without an owner tag", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const { deps, calls } = fakeDeps([[entry({ owner: null })]]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: policy(calls),
      deps,
    }).catch(() => undefined);
    expect(calls.stopped).toHaveLength(0);
  });

  test("throws WorktreeBusyError for a holder it may not stop", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const { deps, calls } = fakeDeps([[entry({ owner: PR_FIX })]]);
    await expect(
      ensureWorktreeLockFree({
        run: fake.run,
        lock: LOCK,
        policy: policy(calls),
        deps,
      }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("throws WorktreeBusyError when the lock stays held after every stop", async () => {
    const fake = createFakeCommandRunner(busyTimes(40));
    const { deps, calls } = fakeDeps([[entry()]]);
    await expect(
      ensureWorktreeLockFree({
        run: fake.run,
        lock: LOCK,
        policy: policy(calls),
        deps,
      }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("stops tagged leftovers of an earlier job even when the lock is free", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    const { deps, calls } = fakeDeps([[entry({ holdsLock: false })], []]);
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: policy(calls),
      deps,
    });
    expect(calls.stopped).toHaveLength(1);
  });

  test("throws WorktreeBusyError when the lock is held but no holder can be seen", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const { deps } = fakeDeps([[]]);
    await expect(
      ensureWorktreeLockFree({ run: fake.run, lock: LOCK, policy: null, deps }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });
});

describe("a probe by another run", () => {
  /** 別の実行がロックを一瞬だけ確かめているflock。タグを持たない。 */
  const PROBE = entry({
    owner: null,
    lockPath: null,
    command: `${FLOCK_PATH} --nonblock --conflict-exit-code ${String(WORKTREE_LOCK_BUSY_EXIT_CODE)} ${LOCK.lockPath} ${TRUE_PATH}`,
  });
  /** 確かめのflockがロックを持ったまま起動した`true`。 */
  const PROBE_CHILD = entry({
    pid: 43,
    ppid: 42,
    pgid: 42,
    owner: null,
    lockPath: null,
    command: TRUE_PATH,
  });
  const ensure = (deps: LockReleaseDeps) =>
    ensureWorktreeLockFree({
      run: createFakeCommandRunner([ok()]).run,
      lock: LOCK,
      policy: null,
      deps,
    });

  test("scans again when only a probe holds the lock", async () => {
    const { deps, calls } = fakeDeps([[PROBE], []]);
    await ensure(deps);
    expect(calls.scans).toBe(2);
  });

  test("is free once the probe is gone", async () => {
    const { deps } = fakeDeps([[PROBE], []]);
    expect(await ensure(deps)).toEqual([]);
  });

  test("treats the command flock runs under a probe as part of it", async () => {
    const { deps } = fakeDeps([[PROBE, PROBE_CHILD], []]);
    expect(await ensure(deps)).toEqual([]);
  });

  test("is busy when the probe is still there on the second scan", async () => {
    const { deps } = fakeDeps([[PROBE]]);
    await expect(ensure(deps)).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("scans again only once", async () => {
    const { deps, calls } = fakeDeps([[PROBE]]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(2);
  });

  test("does not scan again for a holder that is not a probe", async () => {
    const { deps, calls } = fakeDeps([[entry({ owner: null })], []]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(1);
  });

  test("does not scan again for a lone true that no probe started", async () => {
    const { deps, calls } = fakeDeps([[PROBE_CHILD], []]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(1);
  });

  test("does not scan again for a probe of another lock file", async () => {
    const other = entry({
      ...PROBE,
      command: `${FLOCK_PATH} --nonblock --conflict-exit-code ${String(WORKTREE_LOCK_BUSY_EXIT_CODE)} /w/.other.process.lock ${TRUE_PATH}`,
    });
    const { deps, calls } = fakeDeps([[other], []]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(1);
  });
});

describe("a lock file removal by the cleanup", () => {
  /** 掃除がロックを持ったままロックファイルを消すシェル。タグを持たない。 */
  const REMOVAL = entry({
    owner: null,
    lockPath: null,
    command: removeLockFileArgv(LOCK).join(" "),
  });
  /** そのシェルがロックを持ったまま起動したコマンド。 */
  const REMOVAL_CHILD = entry({
    pid: 43,
    ppid: 42,
    pgid: 42,
    owner: null,
    lockPath: null,
    command: "/usr/bin/stat -L -c %d:%i /proc/self/fd/9",
  });
  /** シェルがexecで置き換わった後のrm。 */
  const REMOVAL_RM = entry({
    owner: null,
    lockPath: null,
    command: `${RM_PATH} -f -- ${LOCK.lockPath}`,
  });
  const ensure = (deps: LockReleaseDeps) =>
    ensureWorktreeLockFree({
      run: createFakeCommandRunner([ok()]).run,
      lock: LOCK,
      policy: null,
      deps,
    });

  test("scans again when only a removal holds the lock", async () => {
    const { deps } = fakeDeps([[REMOVAL], []]);
    expect(await ensure(deps)).toEqual([]);
  });

  test("treats a command the removal runs under the lock as part of it", async () => {
    const { deps } = fakeDeps([[REMOVAL, REMOVAL_CHILD], []]);
    expect(await ensure(deps)).toEqual([]);
  });

  test("treats the rm the removal turned into as part of it", async () => {
    const { deps } = fakeDeps([[REMOVAL_RM], []]);
    expect(await ensure(deps)).toEqual([]);
  });

  test("does not scan again for a removal of another lock file", async () => {
    const other = entry({
      ...REMOVAL,
      command: removeLockFileArgv(
        worktreeLockFor("/w/other", (path) => path),
      ).join(" "),
    });
    const { deps, calls } = fakeDeps([[other], []]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(1);
  });

  test("does not scan again for a tagged process under a removal", async () => {
    const tagged = entry({ pid: 43, ppid: 42, pgid: 42 });
    const { deps, calls } = fakeDeps([[REMOVAL, tagged], []]);
    await ensure(deps).catch(() => undefined);
    expect(calls.scans).toBe(1);
  });
});

describe("worktreeNameOfLockFile", () => {
  test("returns the worktree name of a lock file name", () => {
    expect(worktreeNameOfLockFile(".factory-issue-7.process.lock")).toBe(
      "factory-issue-7",
    );
  });

  test("keeps dots inside the worktree name", () => {
    expect(worktreeNameOfLockFile(".v1.2.process.lock")).toBe("v1.2");
  });

  test("rejects a name without the leading dot", () => {
    expect(worktreeNameOfLockFile("wt.process.lock")).toBeNull();
  });

  test("rejects a worktree name that starts with a dot", () => {
    expect(worktreeNameOfLockFile("..wt.process.lock")).toBeNull();
  });

  test("rejects an empty worktree name", () => {
    expect(worktreeNameOfLockFile("..process.lock")).toBeNull();
  });

  test("rejects another suffix", () => {
    expect(worktreeNameOfLockFile(".wt.process.lock.bak")).toBeNull();
  });
});

describe("removeLockFileUnderLock", () => {
  test("passes the worktree and the lock file to the removal shell", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await removeLockFileUnderLock({ run: fake.run, lock: LOCK });
    expect(fake.calls[0]?.argv.slice(3)).toEqual([
      "sh",
      LOCK.worktreeDir,
      LOCK.lockPath,
    ]);
  });

  test("reports removed when the shell exits 0", async () => {
    const fake = createFakeCommandRunner([ok()]);
    expect(await removeLockFileUnderLock({ run: fake.run, lock: LOCK })).toBe(
      "removed",
    );
  });

  test("reports held on the conflict code with no output", async () => {
    const fake = createFakeCommandRunner([busy()]);
    expect(await removeLockFileUnderLock({ run: fake.run, lock: LOCK })).toBe(
      "held",
    );
  });

  test("reports a worktree that appeared before the removal", async () => {
    const fake = createFakeCommandRunner([fail("", 214)]);
    expect(await removeLockFileUnderLock({ run: fake.run, lock: LOCK })).toBe(
      "worktree_exists",
    );
  });

  test("reports a lock file replaced before the removal", async () => {
    const fake = createFakeCommandRunner([fail("", 215)]);
    expect(await removeLockFileUnderLock({ run: fake.run, lock: LOCK })).toBe(
      "replaced",
    );
  });

  test("reports a path that is no longer an empty file", async () => {
    const fake = createFakeCommandRunner([fail("", 216)]);
    expect(await removeLockFileUnderLock({ run: fake.run, lock: LOCK })).toBe(
      "not_lock_file",
    );
  });

  test("throws when the shell fails otherwise", async () => {
    const fake = createFakeCommandRunner([fail("rm: cannot remove", 1)]);
    await expect(
      removeLockFileUnderLock({ run: fake.run, lock: LOCK }),
    ).rejects.toThrow("rm: cannot remove");
  });
});

describe("removeOrphanLockFiles", () => {
  const ROOT = "/workspaces/acme/widgets";
  const ORPHAN = `${ROOT}/.gone.process.lock`;

  type FakeFs = {
    readonly files: Record<string, "empty_file" | "other">;
    readonly dirs: Record<string, readonly string[]>;
  };

  /** 偽のファイルシステムと走査で掃除を走らせ、消したロックファイルと走査したロックファイルを記録する依存。 */
  function sweepDeps(
    fs: FakeFs,
    opts: {
      readonly scan?: readonly LockProcess[];
      readonly removal?: "removed" | "held";
      readonly realpath?: (path: string) => string;
      readonly failRemove?: string;
    } = {},
  ): { deps: OrphanLockFileDeps; removed: string[]; scans: string[] } {
    const removed: string[] = [];
    const scans: string[] = [];
    return {
      removed,
      scans,
      deps: {
        realpath: async (path) => {
          if (opts.realpath !== undefined) return opts.realpath(path);
          if (fs.dirs[path] === undefined) throw errno("ENOENT");
          return path;
        },
        listDir: async (dir) => {
          const names = fs.dirs[dir];
          if (names === undefined) throw errno("ENOENT");
          return names;
        },
        entryKind: async (path) => fs.files[path] ?? "missing",
        scan: async (lock) => {
          scans.push(lock.lockPath);
          return opts.scan ?? [];
        },
        remove: async (lock) => {
          if (lock.lockPath === opts.failRemove)
            throw new Error("rm: cannot remove");
          const result = opts.removal ?? "removed";
          if (result === "removed") removed.push(lock.lockPath);
          return result;
        },
      },
    };
  }

  const ONE_ORPHAN: FakeFs = {
    files: { [ORPHAN]: "empty_file" },
    dirs: { [ROOT]: [".gone.process.lock"] },
  };
  const WORKTREE_STILL_THERE: FakeFs = {
    files: { [ORPHAN]: "empty_file", [`${ROOT}/gone`]: "other" },
    dirs: ONE_ORPHAN.dirs,
  };

  test("removes the lock file of a worktree that no longer exists", async () => {
    const { deps, removed } = sweepDeps(ONE_ORPHAN);
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([ORPHAN]);
  });

  test("reports the removal", async () => {
    const { deps } = sweepDeps(ONE_ORPHAN);
    expect(await removeOrphanLockFiles([ROOT], deps)).toEqual([
      { path: ORPHAN, result: "removed", detail: null },
    ]);
  });

  test("leaves the lock file of a worktree that still exists", async () => {
    const { deps, removed } = sweepDeps(WORKTREE_STILL_THERE);
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("does not scan for the lock file of a worktree that still exists", async () => {
    const { deps, scans } = sweepDeps(WORKTREE_STILL_THERE);
    await removeOrphanLockFiles([ROOT], deps);
    expect(scans).toEqual([]);
  });

  test("ignores a file whose name is not a lock file name", async () => {
    const { deps, removed } = sweepDeps({
      files: { [`${ROOT}/.gone.lock`]: "empty_file" },
      dirs: { [ROOT]: [".gone.lock"] },
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("ignores a lock file name for a worktree name starting with a dot", async () => {
    const { deps, removed } = sweepDeps({
      files: { [`${ROOT}/..gone.process.lock`]: "empty_file" },
      dirs: { [ROOT]: ["..gone.process.lock"] },
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("ignores a lock file name that is not an empty regular file", async () => {
    const { deps, removed } = sweepDeps({
      files: { [ORPHAN]: "other" },
      dirs: ONE_ORPHAN.dirs,
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("leaves a lock file that a process holds", async () => {
    const { deps, removed } = sweepDeps(ONE_ORPHAN, {
      scan: [entry({ owner: null, lockPath: null, holdsLock: true })],
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("leaves a lock file named by a leftover's tag", async () => {
    const { deps, removed } = sweepDeps(ONE_ORPHAN, {
      scan: [entry({ lockPath: ORPHAN, holdsLock: false })],
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("reports a lock file kept for a related process as in use", async () => {
    const { deps } = sweepDeps(ONE_ORPHAN, {
      scan: [entry({ lockPath: ORPHAN, holdsLock: false })],
    });
    const [outcome] = await removeOrphanLockFiles([ROOT], deps);
    expect(outcome?.result).toBe("in_use");
  });

  test("leaves a lock file while a process cannot be inspected", async () => {
    const { deps, removed } = sweepDeps(ONE_ORPHAN, {
      scan: [
        entry({
          owner: null,
          lockPath: null,
          holdsLock: false,
          uninspectable: true,
        }),
      ],
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([]);
  });

  test("ignores a leftover tagged with another lock file", async () => {
    const { deps, removed } = sweepDeps(ONE_ORPHAN, {
      scan: [
        entry({ lockPath: `${ROOT}/.other.process.lock`, holdsLock: false }),
      ],
    });
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([ORPHAN]);
  });

  test("reports what the removal under the lock found", async () => {
    const { deps } = sweepDeps(ONE_ORPHAN, { removal: "held" });
    const [outcome] = await removeOrphanLockFiles([ROOT], deps);
    expect(outcome?.result).toBe("held");
  });

  test("looks in the real path of the directory", async () => {
    const { deps, scans } = sweepDeps(ONE_ORPHAN, { realpath: () => ROOT });
    await removeOrphanLockFiles(["/link/widgets"], deps);
    expect(scans).toEqual([ORPHAN]);
  });

  test("looks at a directory once even when it is given twice", async () => {
    const { deps, scans } = sweepDeps(ONE_ORPHAN);
    await removeOrphanLockFiles([ROOT, ROOT], deps);
    expect(scans).toEqual([ORPHAN]);
  });

  test("skips a directory that no longer exists", async () => {
    const { deps } = sweepDeps(ONE_ORPHAN);
    expect(await removeOrphanLockFiles([`${ROOT}/gone-dir`], deps)).toEqual([]);
  });

  test("keeps going after a lock file it could not remove", async () => {
    const second = `${ROOT}/.later.process.lock`;
    const { deps, removed } = sweepDeps(
      {
        files: { [ORPHAN]: "empty_file", [second]: "empty_file" },
        dirs: { [ROOT]: [".gone.process.lock", ".later.process.lock"] },
      },
      { failRemove: ORPHAN },
    );
    await removeOrphanLockFiles([ROOT], deps);
    expect(removed).toEqual([second]);
  });

  test("reports a lock file it could not remove as failed", async () => {
    const { deps } = sweepDeps(ONE_ORPHAN, { failRemove: ORPHAN });
    const [outcome] = await removeOrphanLockFiles([ROOT], deps);
    expect(outcome?.result).toBe("failed");
  });
});

describe("a process that cannot be inspected", () => {
  /** ロックを持ち、持ち主タグとロックファイルのタグを持つpid 10。 */
  const TAGGED_HOLDER: FakeProc = {
    stat: statLine(10, 1, 10, 1),
    environ: `${LOCK_OWNER_ENV}=implement:3:job-a\0${LOCK_PATH_ENV}=${LOCK.lockPath}\0`,
    fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
  };

  /** `path`の読み取り(`method`)だけを`err`で失敗させる偽の/proc。 */
  function failingProcFs(
    procs: Record<string, FakeProc>,
    method: "readdir" | "readText" | "fileId",
    path: string,
    err: Error,
  ): ProcFs {
    const base = fakeProcFs({ ...SELF_PROCS, ...procs });
    const failOn =
      (read: (target: string) => Promise<string>) =>
      async (target: string): Promise<string> => {
        if (target === path) throw err;
        return read(target);
      };
    return {
      readdir: async (target) => {
        if (method === "readdir" && target === path) throw err;
        return base.readdir(target);
      },
      readText: method === "readText" ? failOn(base.readText) : base.readText,
      fileId: method === "fileId" ? failOn(base.fileId) : base.fileId,
    };
  }

  const scanFailing = (
    method: "readdir" | "readText" | "fileId",
    path: string,
    err: Error,
    lock: WorktreeLock = LOCK,
  ) =>
    scanLockProcesses(
      lock,
      failingProcFs({ "10": TAGGED_HOLDER }, method, path, err),
      900,
    );

  test("lists a process whose environment cannot be read", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      errno("EACCES"),
    );
    expect(entries[0]?.uninspectable).toBe(true);
  });

  test("does not trust the owner tag of a process whose fds cannot be read", async () => {
    const entries = await scanFailing("readdir", "/proc/10/fd", errno("EPERM"));
    expect(entries[0]?.owner).toBeNull();
  });

  test("does not trust the lock file tag of a process whose fds cannot be read", async () => {
    const entries = await scanFailing("readdir", "/proc/10/fd", errno("EPERM"));
    expect(entries[0]?.lockPath).toBeNull();
  });

  test("lists a process whose fd target cannot be read", async () => {
    const entries = await scanFailing(
      "fileId",
      "/proc/10/fd/3",
      errno("EACCES"),
    );
    expect(entries[0]?.uninspectable).toBe(true);
  });

  test("lists a process whose fdinfo cannot be read", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/fdinfo/3",
      errno("EACCES"),
    );
    expect(entries[0]?.uninspectable).toBe(true);
  });

  test("treats a read error without an errno code as uninspectable", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      new Error("boom"),
    );
    expect(entries[0]?.uninspectable).toBe(true);
  });

  test("lists an uninspectable process even when the lock file is gone", async () => {
    const missing = worktreeLockFor("/nowhere/wt", (path) => path);
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      errno("EACCES"),
      missing,
    );
    expect(entries[0]?.uninspectable).toBe(true);
  });

  test("skips a process whose environment is gone", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      errno("ENOENT"),
    );
    expect(entries).toHaveLength(0);
  });

  test("skips a process that exits while its environment is read", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      errno("ESRCH"),
    );
    expect(entries).toHaveLength(0);
  });

  test("treats a process whose fd dir is gone after its environment was read as gone", async () => {
    const entries = await scanLockProcesses(
      LOCK,
      failingProcFs(
        {
          "10": {
            stat: statLine(10, 1, 10, 1),
            environ: "PATH=/usr/bin\0",
            fds: { "3": { id: LOCK_ID, fdinfo: FLOCK_LINE } },
          },
        },
        "readdir",
        "/proc/10/fd",
        errno("ENOENT"),
      ),
      900,
    );
    expect(entries).toHaveLength(0);
  });

  test("does not count a fd that closed during the scan", async () => {
    const entries = await scanFailing(
      "fileId",
      "/proc/10/fd/3",
      errno("ENOENT"),
    );
    expect(entries[0]?.holdsLock).toBe(false);
  });

  // カーネルスレッドのように、environが空でfdが無いプロセスは関係しない。
  test("ignores a readable process with an empty environment and no fds", async () => {
    const entries = await scanLockProcesses(
      LOCK,
      fakeProcFs({
        ...SELF_PROCS,
        "2": { stat: statLine(2, 0, 0, 1), fds: {} },
      }),
      900,
    );
    expect(entries).toHaveLength(0);
  });

  test("makes the plan busy", async () => {
    const entries = await scanFailing(
      "readText",
      "/proc/10/environ",
      errno("EACCES"),
    );
    expect(planLockRelease(entries, LOCK, THIS_JOB).kind).toBe("busy");
  });

  /** environが読めないpid 10を返し続ける走査で、止めた対象を記録する依存。 */
  function uninspectableDeps(stopped: (readonly LockProcess[])[]) {
    const deps: LockReleaseDeps = {
      scan: (lock) =>
        scanLockProcesses(
          lock,
          failingProcFs(
            { "10": TAGGED_HOLDER },
            "readText",
            "/proc/10/environ",
            errno("EACCES"),
          ),
          900,
        ),
      stop: async (targets) => {
        stopped.push(targets);
      },
      sleep: async () => {},
    };
    return deps;
  }

  test("throws WorktreeBusyError", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    await expect(
      ensureWorktreeLockFree({
        run: fake.run,
        lock: LOCK,
        policy: { self: THIS_JOB, recheck: async () => {} },
        deps: uninspectableDeps([]),
      }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  test("is not stopped", async () => {
    const fake = createFakeCommandRunner(busyTimes(4));
    const stopped: (readonly LockProcess[])[] = [];
    await ensureWorktreeLockFree({
      run: fake.run,
      lock: LOCK,
      policy: { self: THIS_JOB, recheck: async () => {} },
      deps: uninspectableDeps(stopped),
    }).then(
      () => {
        throw new Error("expected WorktreeBusyError");
      },
      (err: unknown) => {
        if (!(err instanceof WorktreeBusyError)) throw err;
      },
    );
    expect(stopped).toHaveLength(0);
  });
});

describe("process lock with the real flock and /proc", () => {
  const supported = process.platform === "linux" && existsSync(FLOCK_PATH);
  // /procを全件走査するテストはrootでだけ走らせる。
  // 走査は、見えるプロセスをすべて読めることを前提にする(workerは自分のPID名前空間の中でrootとして動く)。
  // 非rootでホストのPID名前空間を見ると、カーネルスレッドや他のユーザーのプロセスが読めず、保持者と同じく扱われるため。
  const scansAsRoot = supported && process.getuid?.() === 0;
  const tempDirs: string[] = [];
  const tempLock = () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-lock-"));
    tempDirs.push(dir);
    return worktreeLockFor(join(dir, "wt"));
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!supported)(
    "reports held while a locked command is still running",
    async () => {
      const lock = tempLock();
      const running = withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "1"]);
      await Bun.sleep(200);
      const state = await probeWorktreeLock({ run: runCommand, lock });
      await running;
      expect(state).toBe("held");
    },
  );

  test.skipIf(!supported)(
    "reports free once the locked command has exited",
    async () => {
      const lock = tempLock();
      await withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "0"]);
      expect(await probeWorktreeLock({ run: runCommand, lock })).toBe("free");
    },
  );

  test.skipIf(!scansAsRoot)(
    "finds the running holder with its owner tag",
    async () => {
      const lock = tempLock();
      const running = withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "1"]);
      await Bun.sleep(200);
      const entries = await scanLockProcesses(lock);
      await running;
      expect(
        entries.some(
          (found) => found.holdsLock && found.owner?.jobId === "job-a",
        ),
      ).toBe(true);
    },
  );

  test.skipIf(!scansAsRoot)(
    "stops a holder left by another job of the same work item",
    async () => {
      const lock = tempLock();
      const running = withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "30"]);
      await Bun.sleep(200);
      await ensureWorktreeLockFree({
        run: runCommand,
        lock,
        policy: { self: THIS_JOB, recheck: async () => {} },
        deps: defaultLockReleaseDeps(200),
      });
      await running;
      expect(await probeWorktreeLock({ run: runCommand, lock })).toBe("free");
    },
  );

  // 保持者は、塞がりの確かめ直しと走査が終わるまで生きている必要があるので5秒走らせる。その終了を待つので、テストの時間切れを既定の5秒より延ばす。
  test.skipIf(!scansAsRoot)(
    "leaves a holder of another work item running",
    async () => {
      const lock = tempLock();
      const running = withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "5"]);
      await Bun.sleep(200);
      const outcome = await ensureWorktreeLockFree({
        run: runCommand,
        lock,
        policy: {
          self: { ...THIS_JOB, workItemId: 4 },
          recheck: async () => {},
        },
        deps: defaultLockReleaseDeps(200),
      }).catch((err: unknown) => err);
      await running;
      expect(outcome).toBeInstanceOf(WorktreeBusyError);
    },
    10_000,
  );

  test.skipIf(!supported)(
    "removes a free lock file whose worktree is gone",
    async () => {
      const lock = tempLock();
      writeFileSync(lock.lockPath, "");
      await removeLockFileUnderLock({ run: runCommand, lock });
      expect(existsSync(lock.lockPath)).toBe(false);
    },
  );

  test.skipIf(!supported)(
    "keeps a lock file whose worktree exists",
    async () => {
      const lock = tempLock();
      writeFileSync(lock.lockPath, "");
      mkdirSync(lock.worktreeDir);
      expect(await removeLockFileUnderLock({ run: runCommand, lock })).toBe(
        "worktree_exists",
      );
    },
  );

  test.skipIf(!supported)(
    "does not remove a symlink in place of the lock file",
    async () => {
      const lock = tempLock();
      const target = `${lock.lockPath}.target`;
      writeFileSync(target, "");
      symlinkSync(target, lock.lockPath);
      expect(await removeLockFileUnderLock({ run: runCommand, lock })).toBe(
        "not_lock_file",
      );
    },
  );

  test.skipIf(!supported)(
    "keeps a lock file that a running command holds",
    async () => {
      const lock = tempLock();
      const running = withWorktreeProcessLock(
        runCommand,
        lock,
        OTHER_JOB,
      )(["/bin/sleep", "1"]);
      await Bun.sleep(200);
      const result = await removeLockFileUnderLock({ run: runCommand, lock });
      await running;
      expect(result).toBe("held");
    },
  );
});
