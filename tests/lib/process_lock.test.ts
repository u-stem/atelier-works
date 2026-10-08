import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
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
  ownerFromEnviron,
  type ProcFs,
  type ProcStat,
  parseLockOwner,
  parseProcStat,
  planLockRelease,
  probeWorktreeLock,
  type SignalDeps,
  scanLockProcesses,
  stopProcesses,
  TRUE_PATH,
  WORKTREE_BUSY_REASON,
  WORKTREE_LOCK_BUSY_EXIT_CODE,
  WorktreeBusyError,
  WorktreeLockHeldInRunError,
  withWorktreeProcessLock,
  worktreeLockFor,
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

/** pidごとの内容を持つ偽の/proc。ロックファイルのdev/inoはLOCK_ID。 */
function fakeProcFs(procs: Record<string, FakeProc>): ProcFs {
  const proc = (path: string): FakeProc => {
    const found = procs[path.split("/")[2] ?? ""];
    if (found === undefined) throw new Error("ENOENT");
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
      throw new Error("ENOENT");
    },
    fileId: async (path) => {
      if (path === LOCK.lockPath) return LOCK_ID;
      const [, , , , fd = ""] = path.split("/");
      const id = proc(path).fds?.[fd]?.id;
      if (id === undefined) throw new Error("ENOENT");
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

  test("masks secrets in the command", () => {
    const token = `sk-ant-${"x".repeat(20)}`;
    expect(
      formatLockHolders([entry({ command: `claude --token ${token}` })]),
    ).not.toContain(token);
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

describe("process lock with the real flock and /proc", () => {
  const supported = process.platform === "linux" && existsSync(FLOCK_PATH);
  const tempLock = () =>
    worktreeLockFor(join(mkdtempSync(join(tmpdir(), "factory-lock-")), "wt"));

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

  test.skipIf(!supported)(
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

  test.skipIf(!supported)(
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
  test.skipIf(!supported)(
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
});
