import { describe, expect, test } from "bun:test";
import {
  acquireSlot,
  CHECK_ENV_KEYS,
  type CheckDirs,
  type CheckIdentity,
  type CheckSandboxDeps,
  CheckSlotsBusyError,
  checkEnv,
  chownBackArgv,
  chownToArgv,
  createCheckSandbox,
  DEFAULT_CHECK_UID,
  DEFAULT_POOL_SIZE,
  dropWriteBitsArgv,
  isTaggedProcess,
  kernelWarningText,
  newCheckIdentity,
  parseCheckUid,
  parsePasswdUsers,
  parsePoolSize,
  parseProcStatus,
  type ReapDeps,
  reapCheckProcesses,
  reapUidProcesses,
  resolveCheckPool,
  restoreCheckOwnership,
  SETPRIV_PATH,
  type SlotDeps,
  type SlotHandle,
  setprivArgv,
  WINDMILL_TMP_DIR,
} from "../../f/factory/lib/check_sandbox.ts";
import { createFakeCommandRunner, fail, ok } from "./testSupport.ts";

const IDENTITY: CheckIdentity = { uid: 10001, gid: 10001, tagGid: 424242 };
const DIRS: CheckDirs = {
  worktreeDir: "/workspaces/acme/widgets/wt-1",
  homeDir: "/tmp/factory-check-home-abc",
};

/** `/proc/<pid>/status`のうち、判定に使う欄だけの写し。 */
function status(opts: {
  state?: string;
  uid?: number;
  groups?: readonly number[];
}): string {
  const uid = opts.uid ?? IDENTITY.uid;
  return [
    "Name:\tbun",
    `State:\t${opts.state ?? "S (sleeping)"}`,
    `Uid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}`,
    `Gid:\t${String(IDENTITY.gid)}\t${String(IDENTITY.gid)}\t${String(IDENTITY.gid)}\t${String(IDENTITY.gid)}`,
    `Groups:\t${(opts.groups ?? [IDENTITY.tagGid]).join(" ")} `,
    "",
  ].join("\n");
}

describe("parseCheckUid", () => {
  test("returns the default uid when the value is unset", () => {
    expect(parseCheckUid(undefined)).toBe(DEFAULT_CHECK_UID);
  });

  test("returns the default uid when the value is empty", () => {
    expect(parseCheckUid("")).toBe(DEFAULT_CHECK_UID);
  });

  test("parses a decimal uid", () => {
    expect(parseCheckUid("20000")).toBe(20000);
  });

  test("rejects root", () => {
    expect(() => parseCheckUid("0")).toThrow();
  });

  test("rejects a system uid below 1000", () => {
    expect(() => parseCheckUid("999")).toThrow();
  });

  test("rejects a non-numeric value", () => {
    expect(() => parseCheckUid("factory-check")).toThrow();
  });

  test("rejects a uid with a sign or a fraction", () => {
    expect(() => parseCheckUid("-10001")).toThrow();
  });

  test("rejects a uid beyond the signed 32-bit range", () => {
    expect(() => parseCheckUid("4294967295")).toThrow();
  });
});

describe("parsePoolSize", () => {
  test("returns the default size when the value is unset", () => {
    expect(parsePoolSize(undefined)).toBe(DEFAULT_POOL_SIZE);
  });

  test("parses a decimal size", () => {
    expect(parsePoolSize("12")).toBe(12);
  });

  test("rejects zero", () => {
    expect(() => parsePoolSize("0")).toThrow();
  });

  test("rejects a size above the cap", () => {
    expect(() => parsePoolSize("65")).toThrow();
  });

  test("rejects a non-numeric size", () => {
    expect(() => parsePoolSize("many")).toThrow();
  });
});

describe("parsePasswdUsers", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "factory-check-1:x:10002:10002::/:/usr/sbin/nologin",
    "factory-check-0:x:10001:10001::/:/usr/sbin/nologin",
    "factory-check:x:555:555::/:/usr/sbin/nologin",
    "factory-check-x:x:556:556::/:/usr/sbin/nologin",
    "other:x:1000:1000::/home/other:/bin/sh",
  ].join("\n");

  test("lists the numbered users in index order", () => {
    expect(
      parsePasswdUsers(passwd, "factory-check-").map((user) => user.uid),
    ).toEqual([10001, 10002]);
  });

  test("skips a name without a numeric suffix", () => {
    expect(parsePasswdUsers(passwd, "factory-check-")).toHaveLength(2);
  });

  test("returns nothing for an empty file", () => {
    expect(parsePasswdUsers("", "factory-check-")).toEqual([]);
  });

  test("skips a line whose uid is not a number", () => {
    expect(
      parsePasswdUsers("factory-check-0:x:abc:1::/:/bin/sh", "factory-check-"),
    ).toEqual([]);
  });
});

describe("resolveCheckPool", () => {
  const passwd = () =>
    [
      "factory-check-0:x:20000:20000::/:/usr/sbin/nologin",
      "factory-check-1:x:20001:20001::/:/usr/sbin/nologin",
    ].join("\n");

  test("builds a range from the environment variables", () => {
    expect(
      resolveCheckPool(
        { FACTORY_CHECK_UID: "30000", FACTORY_CHECK_POOL_SIZE: "3" },
        passwd,
      ),
    ).toEqual([30000, 30001, 30002]);
  });

  test("uses the default size with only the uid variable", () => {
    expect(
      resolveCheckPool({ FACTORY_CHECK_UID: "30000" }, passwd),
    ).toHaveLength(DEFAULT_POOL_SIZE);
  });

  test("rejects an invalid uid variable even when passwd is fine", () => {
    expect(() =>
      resolveCheckPool({ FACTORY_CHECK_UID: "0" }, passwd),
    ).toThrow();
  });

  test("rejects a range that leaves the uid space", () => {
    expect(() =>
      resolveCheckPool(
        { FACTORY_CHECK_UID: "2147483647", FACTORY_CHECK_POOL_SIZE: "2" },
        passwd,
      ),
    ).toThrow();
  });

  test("reads the numbered users from passwd when the variable is unset", () => {
    expect(resolveCheckPool({}, passwd)).toEqual([20000, 20001]);
  });

  test("falls back to the default range when passwd cannot be read", () => {
    expect(
      resolveCheckPool({}, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual(
      Array.from(
        { length: DEFAULT_POOL_SIZE },
        (_, i) => DEFAULT_CHECK_UID + i,
      ),
    );
  });

  test("falls back to the default range when passwd has no numbered user", () => {
    expect(resolveCheckPool({}, () => "root:x:0:0::/root:/bin/sh\n")[0]).toBe(
      DEFAULT_CHECK_UID,
    );
  });

  test("rejects a passwd entry that maps a slot to root", () => {
    expect(() =>
      resolveCheckPool({}, () => "factory-check-0:x:0:0::/:/bin/sh\n"),
    ).toThrow();
  });
});

describe("newCheckIdentity", () => {
  test("uses the uid as the primary gid", () => {
    expect(newCheckIdentity(10001, () => 0.5).gid).toBe(10001);
  });

  test("draws the tag gid from the injected random source", () => {
    const low = newCheckIdentity(10001, () => 0).tagGid;
    const high = newCheckIdentity(10001, () => 0.999999).tagGid;
    expect(high).toBeGreaterThan(low);
  });

  test("keeps the tag gid out of the range of ordinary users", () => {
    expect(newCheckIdentity(10001, () => 0).tagGid).toBeGreaterThanOrEqual(
      1_000_000,
    );
  });

  test("keeps the tag gid inside the signed 32-bit range", () => {
    expect(newCheckIdentity(10001, () => 0.999999999).tagGid).toBeLessThan(
      2 ** 31,
    );
  });
});

describe("setprivArgv", () => {
  const argv = setprivArgv(IDENTITY, ["bun", "test"]);

  test("starts with the absolute setpriv path", () => {
    expect(argv[0]).toBe(SETPRIV_PATH);
  });

  test("switches the real and effective uid", () => {
    expect(argv).toContain("--reuid=10001");
  });

  test("switches the real and effective gid", () => {
    expect(argv).toContain("--regid=10001");
  });

  test("replaces the supplementary groups with the run's tag gid only", () => {
    expect(argv.filter((arg) => arg.startsWith("--groups="))).toEqual([
      "--groups=424242",
    ]);
  });

  test("empties the bounding set", () => {
    expect(argv).toContain("--bounding-set=-all");
  });

  test("empties the inheritable capabilities", () => {
    expect(argv).toContain("--inh-caps=-all");
  });

  test("sets no_new_privs", () => {
    expect(argv).toContain("--no-new-privs");
  });

  test("puts the command after a -- separator", () => {
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "bun", "test"]);
  });

  test("does not let the command's first word act as a setpriv option", () => {
    const wrapped = setprivArgv(IDENTITY, ["--reuid=0", "x"]);
    expect(wrapped.indexOf("--")).toBeLessThan(wrapped.indexOf("--reuid=0"));
  });

  test("never asks to keep the privileged identity", () => {
    expect(argv.filter((arg) => arg === "--reuid=0")).toEqual([]);
  });
});

describe("checkEnv", () => {
  const env = checkEnv({
    path: "/usr/bin",
    home: "/tmp/h",
    worktreeDir: "/workspaces/a/b/c",
  });

  test("sets the fixed PATH", () => {
    expect(env.PATH).toBe("/usr/bin");
  });

  test("sets the private HOME", () => {
    expect(env.HOME).toBe("/tmp/h");
  });

  test("sets a UTF-8 locale", () => {
    expect(env.LANG).toBe("C.UTF-8");
  });

  test("trusts only the worktree for git's ownership check", () => {
    expect([
      env.GIT_CONFIG_COUNT,
      env.GIT_CONFIG_KEY_0,
      env.GIT_CONFIG_VALUE_0,
    ]).toEqual(["1", "safe.directory", "/workspaces/a/b/c"]);
  });

  test("holds no key outside the allow list", () => {
    expect(
      Object.keys(env).filter(
        (key) => !CHECK_ENV_KEYS.some((allowed) => allowed === key),
      ),
    ).toEqual([]);
  });

  test("does not read the worker's own environment", () => {
    const before = process.env.WM_TOKEN;
    process.env.WM_TOKEN = "worker-secret";
    try {
      const built = checkEnv({
        path: "/usr/bin",
        home: "/tmp/h",
        worktreeDir: "/w",
      });
      expect(Object.values(built)).not.toContain("worker-secret");
    } finally {
      if (before === undefined) delete process.env.WM_TOKEN;
      else process.env.WM_TOKEN = before;
    }
  });
});

describe("chown argv", () => {
  const to = chownToArgv(IDENTITY, DIRS.worktreeDir);
  const back = chownBackArgv(IDENTITY, DIRS.worktreeDir);

  test("walks with find -P so symlinks are not followed", () => {
    expect(to.slice(0, 3)).toEqual(["/usr/bin/find", "-P", DIRS.worktreeDir]);
  });

  test("stays on one filesystem", () => {
    expect(to).toContain("-xdev");
  });

  test("changes the link itself rather than its target", () => {
    expect(to).toContain("-h");
  });

  test("hands over only entries that root owns", () => {
    expect(to).toContain("--from=0:0");
  });

  test("hands over to the check uid and gid", () => {
    expect(to).toContain("10001:10001");
  });

  test("skips regular files with more than one hard link when handing over", () => {
    expect(to.join(" ")).toContain("( -type d -o -links 1 )");
  });

  test("takes back only entries that the check uid owns", () => {
    expect(back).toContain("--from=10001");
  });

  test("takes back to root", () => {
    expect(back).toContain("0:0");
  });

  test("takes back entries regardless of their hard link count", () => {
    expect(back.join(" ")).not.toContain("-links");
  });

  test("also uses find -P when taking back", () => {
    expect(back[1]).toBe("-P");
  });

  test("also uses chown -h when taking back", () => {
    expect(back).toContain("-h");
  });

  test("runs chown from the directory of each entry when handing over", () => {
    expect(to).toContain("-execdir");
  });

  test("runs chown from the directory of each entry when taking back", () => {
    expect(back).toContain("-execdir");
  });

  test("never uses -exec, which resolves the full path again", () => {
    expect([...to, ...back]).not.toContain("-exec");
  });

  test("calls chown by an absolute path", () => {
    expect(to).toContain("/usr/bin/chown");
  });

  test("refuses a relative directory", () => {
    expect(() => chownToArgv(IDENTITY, "relative/dir")).toThrow();
  });

  test("refuses the filesystem root", () => {
    expect(() => chownToArgv(IDENTITY, "/")).toThrow();
  });

  test("refuses a top-level directory", () => {
    expect(() => chownBackArgv(IDENTITY, "/workspaces")).toThrow();
  });

  test("refuses a path that is not normalized", () => {
    expect(() => chownToArgv(IDENTITY, "/workspaces/a/../b")).toThrow();
  });
});

describe("dropWriteBitsArgv", () => {
  const argv = dropWriteBitsArgv(DIRS.worktreeDir);

  test("selects entries with a group or other write bit or a setuid or setgid bit", () => {
    expect(argv.join(" ")).toContain("-perm /6022");
  });

  test("skips symlinks", () => {
    expect(argv.join(" ")).toContain("! -type l");
  });

  test("runs chmod from the directory of each entry", () => {
    expect(argv).toContain("-execdir");
  });

  test("removes the write bits of group and other and the setid bits", () => {
    expect(argv).toContain("go-w,ug-s");
  });

  test("stays on one filesystem", () => {
    expect(argv).toContain("-xdev");
  });

  test("refuses a top-level directory", () => {
    expect(() => dropWriteBitsArgv("/workspaces")).toThrow();
  });
});

describe("parseProcStatus", () => {
  test("reads the state letter", () => {
    expect(parseProcStatus(status({ state: "R (running)" }))?.state).toBe("R");
  });

  test("reads the real uid", () => {
    expect(parseProcStatus(status({ uid: 777 }))?.uid).toBe(777);
  });

  test("reads the supplementary groups", () => {
    expect(parseProcStatus(status({ groups: [5, 6] }))?.groups).toEqual([5, 6]);
  });

  test("reads an empty group list", () => {
    expect(parseProcStatus(status({ groups: [] }))?.groups).toEqual([]);
  });

  test("returns null for text without a Uid line", () => {
    expect(parseProcStatus("Name:\tbun\nState:\tS (sleeping)\n")).toBeNull();
  });

  test("returns null for an empty text", () => {
    expect(parseProcStatus("")).toBeNull();
  });
});

describe("isTaggedProcess", () => {
  const parsed = (text: string) => {
    const result = parseProcStatus(text);
    if (result === null) throw new Error("fixture must parse");
    return result;
  };

  test("accepts a live process with the check uid and the tag gid", () => {
    expect(isTaggedProcess(parsed(status({})), IDENTITY)).toBe(true);
  });

  test("rejects a process of another uid even with the tag gid", () => {
    expect(isTaggedProcess(parsed(status({ uid: 0 })), IDENTITY)).toBe(false);
  });

  test("rejects a check-uid process of another run", () => {
    expect(
      isTaggedProcess(parsed(status({ groups: [999999] })), IDENTITY),
    ).toBe(false);
  });

  test("rejects a zombie", () => {
    expect(
      isTaggedProcess(parsed(status({ state: "Z (zombie)" })), IDENTITY),
    ).toBe(false);
  });

  test("accepts a process whose group list holds the tag among others", () => {
    expect(
      isTaggedProcess(parsed(status({ groups: [1, 424242, 3] })), IDENTITY),
    ).toBe(true);
  });
});

/** 時間とともに消えるプロセス表の偽物。`killedBy`の回数だけ殺されると消える。 */
function fakeReapDeps(table: Record<number, string>) {
  const live = new Map<number, string>(
    Object.entries(table).map(([pid, text]) => [Number(pid), text]),
  );
  const killed: number[] = [];
  const deps: ReapDeps = {
    listPids: async () => [...live.keys()],
    readStatus: async (pid) => live.get(pid) ?? null,
    kill: (pid) => {
      killed.push(pid);
      live.delete(pid);
    },
    sleep: async () => {},
  };
  return { deps, killed, live };
}

describe("reapCheckProcesses", () => {
  test("kills a process carrying the run's tag", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    await reapCheckProcesses(IDENTITY, fake.deps);
    expect(fake.killed).toEqual([50]);
  });

  test("leaves a check-uid process of another run alone", async () => {
    const fake = fakeReapDeps({ 50: status({ groups: [999999] }) });
    await reapCheckProcesses(IDENTITY, fake.deps);
    expect(fake.killed).toEqual([]);
  });

  test("leaves a root process alone", async () => {
    const fake = fakeReapDeps({ 1: status({ uid: 0, groups: [] }) });
    await reapCheckProcesses(IDENTITY, fake.deps);
    expect(fake.killed).toEqual([]);
  });

  test("returns no remaining pid once everything is gone", async () => {
    const fake = fakeReapDeps({ 50: status({}), 51: status({}) });
    expect(await reapCheckProcesses(IDENTITY, fake.deps)).toEqual([]);
  });

  test("kills a descendant that appears after the first sweep", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    let sweeps = 0;
    const deps: ReapDeps = {
      ...fake.deps,
      sleep: async () => {
        sweeps += 1;
        if (sweeps === 1) fake.live.set(60, status({}));
      },
    };
    await reapCheckProcesses(IDENTITY, deps);
    expect(fake.killed).toEqual([50, 60]);
  });

  test("reports a process that survives every sweep", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    const deps: ReapDeps = { ...fake.deps, kill: () => {} };
    expect(await reapCheckProcesses(IDENTITY, deps)).toEqual([50]);
  });

  test("does not kill a pid whose status no longer matches at kill time", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    let reads = 0;
    const deps: ReapDeps = {
      ...fake.deps,
      // 一覧のときは対象に見え、殺す直前の確認では別のプロセスに変わっている。
      readStatus: async () => {
        reads += 1;
        return reads === 1 ? status({}) : status({ uid: 0, groups: [] });
      },
    };
    await reapCheckProcesses(IDENTITY, deps);
    expect(fake.killed).toEqual([]);
  });

  test("ignores a pid that vanished while listing", async () => {
    const fake = fakeReapDeps({});
    const deps: ReapDeps = { ...fake.deps, listPids: async () => [77] };
    expect(await reapCheckProcesses(IDENTITY, deps)).toEqual([]);
  });
});

describe("reapUidProcesses", () => {
  test("kills a process of the slot uid whatever its tag", async () => {
    const fake = fakeReapDeps({ 50: status({ groups: [] }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.killed).toEqual([50]);
  });

  test("leaves a process of another uid alone", async () => {
    const fake = fakeReapDeps({ 50: status({ uid: 10002, groups: [] }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.killed).toEqual([]);
  });

  test("leaves a zombie alone", async () => {
    const fake = fakeReapDeps({ 50: status({ state: "Z (zombie)" }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.killed).toEqual([]);
  });

  test("reports a process that survives every sweep", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    const deps: ReapDeps = { ...fake.deps, kill: () => {} };
    expect(await reapUidProcesses(IDENTITY.uid, deps)).toEqual([50]);
  });
});

/** 取られている枠を覚え、時間を`sleep`の分だけ進める偽の`SlotDeps`。 */
function fakeSlots(opts?: {
  readonly busy?: readonly number[];
  /** 経過時間が`afterMs`に達したら、枠`index`を空ける。 */
  readonly freeAt?: { readonly index: number; readonly afterMs: number };
}) {
  const held = new Set<number>(opts?.busy ?? []);
  const events: string[] = [];
  let clock = 0;
  const deps: SlotDeps = {
    tryAcquire: async (index) => {
      if (held.has(index)) return null;
      held.add(index);
      events.push(`acquire ${String(index)}`);
      const handle: SlotHandle = {
        index,
        release: async () => {
          held.delete(index);
          events.push(`release ${String(index)}`);
        },
      };
      return handle;
    },
    sleep: async (ms) => {
      clock += ms;
      events.push(`sleep ${String(ms)}`);
      if (opts?.freeAt !== undefined && clock >= opts.freeAt.afterMs) {
        held.delete(opts.freeAt.index);
      }
    },
    now: () => clock,
  };
  return { deps, held, events };
}

describe("acquireSlot", () => {
  const WAIT = { maxWaitMs: 1000, pollMs: 100 };

  test("takes the first slot when every slot is free", async () => {
    const fake = fakeSlots();
    expect((await acquireSlot([0, 1, 2], fake.deps, WAIT)).index).toBe(0);
  });

  test("skips a slot someone else holds", async () => {
    const fake = fakeSlots({ busy: [0] });
    expect((await acquireSlot([0, 1, 2], fake.deps, WAIT)).index).toBe(1);
  });

  test("does not wait when a slot is free", async () => {
    const fake = fakeSlots();
    await acquireSlot([0, 1], fake.deps, WAIT);
    expect(fake.events.filter((event) => event.startsWith("sleep"))).toEqual(
      [],
    );
  });

  test("waits and retries when every slot is held", async () => {
    const fake = fakeSlots({
      busy: [0, 1],
      freeAt: { index: 1, afterMs: 300 },
    });
    expect((await acquireSlot([0, 1], fake.deps, WAIT)).index).toBe(1);
  });

  test("polls at the given interval while it waits", async () => {
    const fake = fakeSlots({
      busy: [0],
      freeAt: { index: 0, afterMs: 200 },
    });
    await acquireSlot([0], fake.deps, WAIT);
    expect(fake.events.filter((event) => event.startsWith("sleep"))).toEqual([
      "sleep 100",
      "sleep 100",
    ]);
  });

  test("fails with a clear error when no slot frees up in time", async () => {
    const fake = fakeSlots({ busy: [0, 1] });
    await expect(acquireSlot([0, 1], fake.deps, WAIT)).rejects.toThrow(
      "no check slot became free within 1s",
    );
  });

  test("throws CheckSlotsBusyError when no slot frees up in time", async () => {
    const fake = fakeSlots({ busy: [0] });
    await expect(acquireSlot([0], fake.deps, WAIT)).rejects.toBeInstanceOf(
      CheckSlotsBusyError,
    );
  });

  test("gives four concurrent runs four different slots", async () => {
    const fake = fakeSlots();
    const handles = await Promise.all(
      [0, 1, 2, 3].map(() =>
        acquireSlot([0, 1, 2, 3, 4, 5, 6, 7], fake.deps, WAIT),
      ),
    );
    expect(new Set(handles.map((handle) => handle.index)).size).toBe(4);
  });

  test("lets a fifth run wait for one of four slots and take it once freed", async () => {
    const fake = fakeSlots({ freeAt: { index: 2, afterMs: 500 } });
    const four = [0, 1, 2, 3];
    await Promise.all(four.map(() => acquireSlot(four, fake.deps, WAIT)));
    const fifth = await acquireSlot(four, fake.deps, WAIT);
    expect(fifth.index).toBe(2);
  });
});

/** 立っているプロセスを持ち、止められると消える`ReapDeps`と、呼び出しを記録する偽の依存。 */
function fakeSandboxDeps(opts?: {
  readonly runResponses?: readonly Parameters<
    typeof createFakeCommandRunner
  >[0][number][];
  /** 殺しても消えないプロセスのpid。 */
  readonly stuck?: readonly number[];
  /** 最初からいるプロセス。 */
  readonly processes?: Record<number, string>;
  readonly busySlots?: readonly number[];
  readonly sysctl?: Record<string, string | null>;
  readonly owners?: Record<string, number | null>;
}) {
  const events: string[] = [];
  const runner = createFakeCommandRunner(
    opts?.runResponses ?? Array.from({ length: 12 }, () => ok()),
  );
  const slots = fakeSlots({ busy: opts?.busySlots ?? [] });
  const live = new Map<number, string>(
    Object.entries(opts?.processes ?? {}).map(([pid, text]) => [
      Number(pid),
      text,
    ]),
  );
  const killed: number[] = [];
  const deps: CheckSandboxDeps = {
    run: async (argv, options) => {
      events.push(`run ${argv[0]?.split("/").pop() ?? ""} ${argv[2] ?? ""}`);
      return runner.run(argv, options);
    },
    reap: {
      listPids: async () => {
        events.push("list");
        return [...live.keys(), ...(opts?.stuck ?? [])];
      },
      readStatus: async (pid) =>
        live.get(pid) ??
        ((opts?.stuck ?? []).includes(pid)
          ? status({ uid: 20000, groups: [1_000_000] })
          : null),
      kill: (pid) => {
        killed.push(pid);
        live.delete(pid);
      },
      sleep: async () => {},
    },
    slots: {
      ...slots.deps,
      tryAcquire: async (index) => {
        const handle = await slots.deps.tryAcquire(index);
        if (handle === null) return null;
        events.push(`acquire ${String(index)}`);
        return {
          index,
          release: async () => {
            events.push(`release-slot ${String(index)}`);
            await handle.release();
          },
        };
      },
    },
    lockDownRuntimeDir: async (dir) => {
      events.push(`lockdown ${dir}`);
    },
    assertDirectory: async (path) => {
      events.push(`assertDirectory ${path}`);
    },
    ownerOf: async (path) => opts?.owners?.[path] ?? null,
    readSysctl: (name) => opts?.sysctl?.[name] ?? null,
  };
  return { deps, events, calls: runner.calls, killed, slots };
}

const POOL = [20000, 20001];

function sandboxOf(
  deps: CheckSandboxDeps,
  extra?: { readonly maxWaitMs?: number; readonly pollMs?: number },
) {
  return createCheckSandbox({ uids: POOL, deps, random: () => 0, ...extra });
}

describe("createCheckSandbox", () => {
  test("refuses to wrap a command before a slot is held", () => {
    const fake = fakeSandboxDeps();
    expect(() => sandboxOf(fake.deps).wrap(["bun", "test"])).toThrow(
      "no slot is held",
    );
  });

  test("wraps a command with setpriv for the held slot's uid", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["bun", "test"])).toContain("--reuid=20000");
  });

  test("ends the wrapped command with a -- separator", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["bun", "test"]).slice(-3)).toEqual([
      "--",
      "bun",
      "test",
    ]);
  });

  test("takes the next slot when the first one is held", async () => {
    const fake = fakeSandboxDeps({ busySlots: [0] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("gives two concurrent runs different uids", async () => {
    const fake = fakeSandboxDeps();
    const first = sandboxOf(fake.deps);
    const second = sandboxOf(fake.deps);
    await first.prepare(DIRS);
    await second.prepare(DIRS);
    expect([first.wrap(["true"])[1], second.wrap(["true"])[1]]).toEqual([
      "--reuid=20000",
      "--reuid=20001",
    ]);
  });

  test("fails with a slot error when every slot stays held", async () => {
    const fake = fakeSandboxDeps({ busySlots: [0, 1] });
    const sandbox = sandboxOf(fake.deps, { maxWaitMs: 100, pollMs: 50 });
    await expect(sandbox.prepare(DIRS)).rejects.toThrow("no check slot");
  });

  test("hands nothing over when no slot could be taken", async () => {
    const fake = fakeSandboxDeps({ busySlots: [0, 1] });
    const sandbox = sandboxOf(fake.deps, { maxWaitMs: 100, pollMs: 50 });
    await sandbox.prepare(DIRS).catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("prepare locks down the runtime directory first", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events[0]).toBe(`lockdown ${WINDMILL_TMP_DIR}`);
  });

  test("prepare checks that the worktree is a real directory", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events).toContain(`assertDirectory ${DIRS.worktreeDir}`);
  });

  test("prepare stops the processes a dead run left in the slot's uid", async () => {
    const fake = fakeSandboxDeps({
      processes: { 77: status({ uid: 20000, groups: [] }) },
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.killed).toEqual([77]);
  });

  test("prepare leaves the processes of another slot's uid alone", async () => {
    const fake = fakeSandboxDeps({
      processes: { 77: status({ uid: 20001, groups: [] }) },
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.killed).toEqual([]);
  });

  test("prepare hands the worktree and the home over to the held uid", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls.map((call) => call.argv[2])).toEqual([
      DIRS.worktreeDir,
      DIRS.homeDir,
    ]);
  });

  test("prepare hands over to the uid of the held slot", async () => {
    const fake = fakeSandboxDeps({ busySlots: [0] });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls[0]?.argv).toContain("20001:20001");
  });

  test("prepare fails when the handover fails", async () => {
    const fake = fakeSandboxDeps({ runResponses: [fail("denied", 1)] });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toThrow("denied");
  });

  test("release after a failed prepare gives the slot back", async () => {
    const fake = fakeSandboxDeps({
      runResponses: [fail("denied", 1), ok(), ok(), ok(), ok()],
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.events).toContain("release-slot 0");
  });

  test("release after a failed prepare takes the worktree back", async () => {
    const fake = fakeSandboxDeps({
      runResponses: [fail("denied", 1), ok(), ok(), ok(), ok()],
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.calls[1]?.argv).toContain("--from=20000");
  });

  test("prepare stops before handing over when the runtime directory cannot be locked down", async () => {
    const fake = fakeSandboxDeps();
    const deps: CheckSandboxDeps = {
      ...fake.deps,
      lockDownRuntimeDir: async () => {
        throw new Error("chmod failed");
      },
    };
    await expect(sandboxOf(deps).prepare(DIRS)).rejects.toThrow("chmod failed");
    expect(fake.calls).toEqual([]);
  });

  test("settle passes when no tagged process is left", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await expect(sandbox.settle()).resolves.toBeUndefined();
  });

  test("settle fails when a tagged process cannot be stopped", async () => {
    const fake = fakeSandboxDeps({ stuck: [50] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await expect(sandbox.settle()).rejects.toThrow("could not be stopped");
  });

  test("release takes the worktree back from the held uid", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    expect(fake.calls[2]?.argv).toContain("--from=20000");
  });

  test("release then drops the write bits of the worktree", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    expect(fake.calls[3]?.argv).toContain("go-w,ug-s");
  });

  test("release takes the home back last", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    expect(fake.calls[4]?.argv[2]).toBe(DIRS.homeDir);
  });

  test("release gives the slot back after taking everything back", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    expect(fake.events.at(-1)).toBe("release-slot 0");
  });

  test("release does not take ownership back while a process survives", async () => {
    const fake = fakeSandboxDeps({ stuck: [50] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    const before = fake.calls.length;
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.calls.length).toBe(before);
  });

  test("release fails loudly while a process survives", async () => {
    const fake = fakeSandboxDeps({ stuck: [50] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await expect(sandbox.release(DIRS)).rejects.toThrow("could not be stopped");
  });

  test("release still gives the slot back while a process survives", async () => {
    const fake = fakeSandboxDeps({ stuck: [50] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.events).toContain("release-slot 0");
  });

  test("release still gives the slot back when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      runResponses: [ok(), ok(), fail("busy", 1)],
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.events).toContain("release-slot 0");
  });

  test("release fails when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      runResponses: [ok(), ok(), fail("busy", 1)],
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await expect(sandbox.release(DIRS)).rejects.toThrow("busy");
  });

  test("release without a held slot does nothing", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).release(DIRS);
    expect(fake.calls).toEqual([]);
  });

  test("a second release does nothing", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    const before = fake.calls.length;
    await sandbox.release(DIRS);
    expect(fake.calls.length).toBe(before);
  });

  test("masks a secret in the failure message", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const fake = fakeSandboxDeps({
      runResponses: [fail(`leaked ${secret}`)],
    });
    const message = await sandboxOf(fake.deps)
      .prepare(DIRS)
      .then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );
    expect(message).not.toContain(secret);
  });

  test("reports no kernel warning when hardlink and symlink protection are on", () => {
    const fake = fakeSandboxDeps({
      sysctl: { "fs/protected_hardlinks": "1", "fs/protected_symlinks": "1" },
    });
    expect(sandboxOf(fake.deps).kernelWarnings()).toEqual([]);
  });

  test("warns when hardlink protection is off", () => {
    const fake = fakeSandboxDeps({
      sysctl: { "fs/protected_hardlinks": "0", "fs/protected_symlinks": "1" },
    });
    expect(sandboxOf(fake.deps).kernelWarnings()).toHaveLength(1);
  });

  test("warns when the protections cannot be read", () => {
    const fake = fakeSandboxDeps();
    expect(sandboxOf(fake.deps).kernelWarnings()).toHaveLength(2);
  });
});

describe("restoreCheckOwnership", () => {
  const WT = DIRS.worktreeDir;

  test("does nothing when the worktree is missing", async () => {
    const fake = fakeSandboxDeps({ owners: {} });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(false);
  });

  test("does nothing when root owns the worktree", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 0 } });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.calls).toEqual([]);
  });

  test("does nothing when another user owns the worktree", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 501 } });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(false);
  });

  test("takes the worktree back from the slot uid that owns it", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 20001 } });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.calls[0]?.argv).toContain("--from=20001");
  });

  test("then drops the write bits", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 20001 } });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.calls[1]?.argv).toContain("go-w,ug-s");
  });

  test("returns true once it took the worktree back", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 20001 } });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(true);
  });

  test("stops the processes a dead run left in that uid", async () => {
    const fake = fakeSandboxDeps({
      owners: { [WT]: 20001 },
      processes: { 90: status({ uid: 20001, groups: [] }) },
    });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.killed).toEqual([90]);
  });

  test("holds the slot while it works and gives it back", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 20001 } });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.events.filter((event) => event.endsWith(" 1"))).toContain(
      "release-slot 1",
    );
  });

  test("still takes the worktree back when a live run holds the slot", async () => {
    const fake = fakeSandboxDeps({ owners: { [WT]: 20001 }, busySlots: [1] });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100);
    expect(fake.calls[0]?.argv).toContain("--from=20001");
  });

  test("does not stop processes when a live run holds the slot", async () => {
    const fake = fakeSandboxDeps({
      owners: { [WT]: 20001 },
      busySlots: [1],
      processes: { 90: status({ uid: 20001, groups: [] }) },
    });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100);
    expect(fake.killed).toEqual([]);
  });

  test("fails when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      owners: { [WT]: 20001 },
      runResponses: [fail("denied", 1)],
    });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      "denied",
    );
  });

  test("gives the slot back when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      owners: { [WT]: 20001 },
      runResponses: [fail("denied", 1)],
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.events).toContain("release-slot 1");
  });
});

describe("kernelWarningText", () => {
  test("is empty without warnings", () => {
    expect(kernelWarningText([])).toBe("");
  });

  test("lists every warning", () => {
    expect(kernelWarningText(["a is off", "b is off"])).toContain(
      "a is off。b is off",
    );
  });

  test("tells the operator that checks continue", () => {
    expect(kernelWarningText(["a is off"])).toContain("検査は続けます");
  });
});
