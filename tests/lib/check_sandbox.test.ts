import { describe, expect, test } from "bun:test";
import {
  acquireSlot,
  CHECK_ENV_KEYS,
  type CheckDirs,
  type CheckIdentity,
  type CheckSandboxDeps,
  CheckSlotsBusyError,
  checkEnv,
  chownToArgv,
  createCheckSandbox,
  DEFAULT_CHECK_UID,
  DEFAULT_POOL_SIZE,
  dropWriteBitsArgv,
  formatSlotRecord,
  gatherArgv,
  type IpcEntry,
  ipcrmArgv,
  isTaggedProcess,
  kernelWarningText,
  leftoverArgv,
  newCheckIdentity,
  openDirsArgv,
  parseCheckUid,
  parsePasswdUsers,
  parsePoolSize,
  parseProcStatus,
  parseSlotRecord,
  parseSysvIpc,
  purgeDirsArgv,
  purgeFilesArgv,
  type ReapDeps,
  reapCheckProcesses,
  reapUidProcesses,
  reclaimArgv,
  remainingOfUidArgv,
  removeTreeArgv,
  resolveCheckPool,
  restoreCheckOwnership,
  SETPRIV_PATH,
  SHARED_TMP_DIRS,
  type SlotDeps,
  type SlotHandle,
  type SlotRecord,
  type SlotSkip,
  setprivArgv,
  slotSkipNoticeText,
  WINDMILL_TMP_DIR,
} from "../../f/factory/lib/check_sandbox.ts";
import type {
  CommandResult,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";
import { fail, ok } from "./testSupport.ts";

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

  test("points TMPDIR into the private HOME", () => {
    expect(env.TMPDIR).toBe("/tmp/h/tmp");
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

describe("chownToArgv", () => {
  const to = chownToArgv(IDENTITY, DIRS.worktreeDir);

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

  test("runs chown from the directory of each entry", () => {
    expect(to).toContain("-execdir");
  });

  test("never uses -exec, which resolves the full path again", () => {
    expect(to).not.toContain("-exec");
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

  test("refuses a path that is not normalized", () => {
    expect(() => chownToArgv(IDENTITY, "/workspaces/a/../b")).toThrow();
  });
});

describe("gatherArgv", () => {
  const argv = gatherArgv(IDENTITY, DIRS.worktreeDir);

  test("runs as root without setpriv", () => {
    expect(argv[0]).toBe("/usr/bin/find");
  });

  test("selects entries the slot uid does not own yet", () => {
    expect(argv.join(" ")).toContain("! -uid 10001");
  });

  test("selects every directory, entries of other users, and loose single-link entries of root", () => {
    expect(argv.join(" ")).toContain(
      "( -type d -o ! -uid 0 -o ( ! -type l -links 1 -perm /6022 ) )",
    );
  });

  test("gives them to the slot uid with chown -h", () => {
    expect(argv.slice(-5)).toEqual([
      "/usr/bin/chown",
      "-h",
      "10001:10001",
      "{}",
      "+",
    ]);
  });

  test("runs chown from the directory of each entry", () => {
    expect(argv).toContain("-execdir");
  });

  test("refuses a top-level directory", () => {
    expect(() => gatherArgv(IDENTITY, "/workspaces")).toThrow();
  });
});

describe("openDirsArgv", () => {
  const argv = openDirsArgv(IDENTITY, DIRS.worktreeDir);

  test("runs as the slot uid through setpriv", () => {
    expect(argv.slice(0, 2)).toEqual([SETPRIV_PATH, "--reuid=10001"]);
  });

  test("selects the slot uid's directories that its owner cannot enter", () => {
    expect(argv.join(" ")).toContain("-uid 10001 -type d ! -perm -u=rwx");
  });

  test("opens each one before find descends into it", () => {
    expect(argv.slice(-5)).toEqual([
      "-execdir",
      "/usr/bin/chmod",
      "u+rwx",
      "{}",
      ";",
    ]);
  });
});

describe("dropWriteBitsArgv", () => {
  const argv = dropWriteBitsArgv(IDENTITY, DIRS.worktreeDir);

  test("runs as the slot uid through setpriv", () => {
    expect(argv.slice(0, 2)).toEqual([SETPRIV_PATH, "--reuid=10001"]);
  });

  test("selects the slot uid's entries with a group or other write bit or a setid bit", () => {
    expect(argv.join(" ")).toContain("-uid 10001 ! -type l -perm /6022");
  });

  test("removes the write bits of group and other and the setid bits", () => {
    expect(argv).toContain("go-w,ug-s");
  });

  test("runs chmod from the directory of each entry", () => {
    expect(argv).toContain("-execdir");
  });

  test("stays on one filesystem", () => {
    expect(argv).toContain("-xdev");
  });

  test("refuses a top-level directory", () => {
    expect(() => dropWriteBitsArgv(IDENTITY, "/workspaces")).toThrow();
  });
});

describe("reclaimArgv", () => {
  const argv = reclaimArgv(DIRS.worktreeDir);

  test("selects every entry that root does not own", () => {
    expect(argv.join(" ")).toContain("-xdev ! -uid 0 -execdir");
  });

  test("gives them to root with chown -h", () => {
    expect(argv.slice(-5)).toEqual(["/usr/bin/chown", "-h", "0:0", "{}", "+"]);
  });

  test("never changes modes as root", () => {
    expect(argv).not.toContain("/usr/bin/chmod");
  });

  test("refuses a top-level directory", () => {
    expect(() => reclaimArgv("/workspaces")).toThrow();
  });
});

describe("leftoverArgv", () => {
  const argv = leftoverArgv(DIRS.worktreeDir);

  test("looks for entries of other users or loose entries", () => {
    expect(argv.join(" ")).toContain(
      "( ! -uid 0 -o ( ! -type l ( -type d -o -links 1 ) -perm /6022 ) )",
    );
  });

  test("stops at the first match", () => {
    expect(argv.slice(-2)).toEqual(["-print", "-quit"]);
  });
});

describe("removeTreeArgv", () => {
  test("removes the tree with rm on one filesystem", () => {
    expect(removeTreeArgv(DIRS.homeDir)).toEqual([
      "/usr/bin/rm",
      "-rf",
      "--one-file-system",
      "--",
      DIRS.homeDir,
    ]);
  });

  test("refuses a top-level directory", () => {
    expect(() => removeTreeArgv("/tmp")).toThrow();
  });
});

describe("shared temporary directories", () => {
  test("cover /tmp, /var/tmp, /dev/shm and the POSIX message queues", () => {
    expect(SHARED_TMP_DIRS).toEqual([
      "/tmp",
      "/var/tmp",
      "/dev/shm",
      "/dev/mqueue",
    ]);
  });

  test("directories of the slot uid are removed whole from their parent", () => {
    expect(purgeDirsArgv(10001, "/tmp").join(" ")).toBe(
      "/usr/bin/find -P /tmp -xdev -mindepth 1 -uid 10001 -type d -prune -execdir /usr/bin/rm -rf --one-file-system -- {} +",
    );
  });

  test("other entries of the slot uid are deleted without following links", () => {
    expect(purgeFilesArgv(10001, "/tmp").join(" ")).toBe(
      "/usr/bin/find -P /tmp -xdev -uid 10001 ! -type d -delete",
    );
  });

  test("the check for remains stops at the first entry of the slot uid", () => {
    expect(remainingOfUidArgv(10001, "/dev/shm").join(" ")).toBe(
      "/usr/bin/find -P /dev/shm -xdev -uid 10001 -print -quit",
    );
  });
});

describe("parseSysvIpc", () => {
  const shm = [
    "       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap",
    "         0          7   600                  1024    55    55      0 10001 10001 10001 10001          0          0 1760000000                     0                     0",
    "         0          8   600                  1024    56    56      0     0     0 10002 10002          0          0 1760000000                     0                     0",
    "",
  ].join("\n");

  test("reads the id of each segment", () => {
    expect(parseSysvIpc(shm, "shm").map((entry) => entry.id)).toEqual([7, 8]);
  });

  test("reads the owner uid", () => {
    expect(parseSysvIpc(shm, "shm")[0]?.uid).toBe(10001);
  });

  test("reads the creator uid", () => {
    expect(parseSysvIpc(shm, "shm")[1]?.cuid).toBe(10002);
  });

  test("returns nothing for a header without rows", () => {
    expect(
      parseSysvIpc("       key      semid perms      nsems   uid\n", "sem"),
    ).toEqual([]);
  });

  test("returns nothing without the id column", () => {
    expect(parseSysvIpc("key perms uid cuid\n0 600 1 1\n", "msg")).toEqual([]);
  });
});

describe("ipcrmArgv", () => {
  const entries: IpcEntry[] = [
    { kind: "shm", id: 7, uid: 1, cuid: 1 },
    { kind: "sem", id: 3, uid: 1, cuid: 1 },
    { kind: "msg", id: 9, uid: 1, cuid: 1 },
  ];

  test("removes each object by its kind and id", () => {
    expect(ipcrmArgv(entries)).toEqual([
      "/usr/bin/ipcrm",
      "-m",
      "7",
      "-s",
      "3",
      "-q",
      "9",
    ]);
  });
});

describe("slot records", () => {
  const record: SlotRecord = {
    worktreeDir: DIRS.worktreeDir,
    homeDir: DIRS.homeDir,
  };

  test("round-trips through the file format", () => {
    expect(parseSlotRecord(formatSlotRecord(record))).toEqual(record);
  });

  test("rejects text that is not JSON", () => {
    expect(parseSlotRecord("{")).toBeNull();
  });

  test("rejects a record without a home", () => {
    expect(
      parseSlotRecord(JSON.stringify({ worktreeDir: DIRS.worktreeDir })),
    ).toBeNull();
  });

  test("rejects a relative path", () => {
    expect(
      parseSlotRecord(
        JSON.stringify({ worktreeDir: "a/b", homeDir: DIRS.homeDir }),
      ),
    ).toBeNull();
  });

  test("rejects a top-level path", () => {
    expect(
      parseSlotRecord(
        JSON.stringify({ worktreeDir: DIRS.worktreeDir, homeDir: "/tmp" }),
      ),
    ).toBeNull();
  });
});

describe("slotSkipNoticeText", () => {
  const skip: SlotSkip = { index: 2, uid: 10003, reason: "pid 77 survived" };

  test("names the slot and its uid", () => {
    expect(slotSkipNoticeText(skip)).toContain("factory-check-2(uid 10003)");
  });

  test("carries the reason", () => {
    expect(slotSkipNoticeText(skip)).toContain("pid 77 survived");
  });

  test("tells the operator what to do", () => {
    expect(slotSkipNoticeText(skip)).toContain("workerを再起動");
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

type FakeCall = {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
};

/**
 * 呼び出しを記録し、プロセス表、枠のロック、枠の記録、IPCの一覧を持つ偽の依存。
 * コマンドは既定で成功し、`respond`が結果を返したものだけその結果にする。
 */
function fakeSandboxDeps(opts?: {
  readonly respond?: (argv: readonly string[]) => CommandResult | undefined;
  /** 殺しても消えないプロセス。pidから実uidへの対応。目印は枠0の実行のもの。 */
  readonly stuck?: Record<number, number>;
  /** 最初からいるプロセス。 */
  readonly processes?: Record<number, string>;
  readonly busySlots?: readonly number[];
  readonly sysctl?: Record<string, string | null>;
  readonly records?: Record<number, SlotRecord>;
  /** 読むと例外になる記録の枠。 */
  readonly corruptRecords?: readonly number[];
  readonly pathKinds?: Record<string, "missing" | "directory" | "other">;
  readonly ipc?: readonly IpcEntry[];
  /** `ipcrm`を実行しても消えない。 */
  readonly ipcStuck?: boolean;
}) {
  const events: string[] = [];
  const calls: FakeCall[] = [];
  const slots = fakeSlots({ busy: opts?.busySlots ?? [] });
  const live = new Map<number, string>(
    Object.entries(opts?.processes ?? {}).map(([pid, text]) => [
      Number(pid),
      text,
    ]),
  );
  const stuck = new Map<number, number>(
    Object.entries(opts?.stuck ?? {}).map(([pid, uid]) => [Number(pid), uid]),
  );
  const records = new Map<number, SlotRecord>(
    Object.entries(opts?.records ?? {}).map(([index, record]) => [
      Number(index),
      record,
    ]),
  );
  let ipc = [...(opts?.ipc ?? [])];
  const killed: number[] = [];
  const deps: CheckSandboxDeps = {
    run: async (argv, options) => {
      calls.push({ argv, options });
      events.push(`run ${argv.join(" ")}`);
      const ipcrmAt = argv.indexOf("/usr/bin/ipcrm");
      if (ipcrmAt >= 0 && opts?.ipcStuck !== true) {
        const flags = argv.slice(ipcrmAt + 1);
        const removed = new Set(flags.filter((_, i) => i % 2 === 1));
        ipc = ipc.filter((entry) => !removed.has(String(entry.id)));
      }
      return opts?.respond?.(argv) ?? ok();
    },
    reap: {
      listPids: async () => [...live.keys(), ...stuck.keys()],
      readStatus: async (pid) => {
        const found = live.get(pid);
        if (found !== undefined) return found;
        const uid = stuck.get(pid);
        return uid === undefined ? null : status({ uid, groups: [1_000_000] });
      },
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
    slotRecords: {
      read: async (index) => {
        if ((opts?.corruptRecords ?? []).includes(index)) {
          throw new Error(`unreadable record ${String(index)}`);
        }
        return records.get(index) ?? null;
      },
      write: async (index, record) => {
        events.push(`record-write ${String(index)}`);
        records.set(index, record);
      },
      clear: async (index) => {
        events.push(`record-clear ${String(index)}`);
        records.delete(index);
      },
    },
    listIpc: async () => ipc,
    lockDownRuntimeDir: async (dir) => {
      events.push(`lockdown ${dir}`);
    },
    assertDirectory: async (path) => {
      events.push(`assertDirectory ${path}`);
    },
    pathKind: async (path) => opts?.pathKinds?.[path] ?? "directory",
    readSysctl: (name) => opts?.sysctl?.[name] ?? null,
  };
  return { deps, events, calls, killed, records };
}

const POOL = [20000, 20001];
const SLOT0 = newCheckIdentity(20000, () => 0);
const SLOT1 = newCheckIdentity(20001, () => 0);
const OLD: SlotRecord = {
  worktreeDir: "/workspaces/acme/other/wt-9",
  homeDir: "/tmp/factory-check-home-old",
};

/** 止めても消えない、枠0の実行の目印を持つプロセスだけがいる`ReapDeps`の差し替え。 */
const STUCK_TAGGED: Partial<ReapDeps> = {
  listPids: async () => [50],
  readStatus: async () => status({ uid: 20000, groups: [1_000_000] }),
  kill: () => {},
};

const ran = (argv: readonly string[]): string => `run ${argv.join(" ")}`;
const argvOf = (calls: readonly FakeCall[]): string[][] =>
  calls.map((call) => [...call.argv]);
const matches =
  (expected: readonly string[]) =>
  (argv: readonly string[]): boolean =>
    argv.join("\0") === expected.join("\0");

/** 実行ごとに変わる目印のgidを伏せる。目印を選べない呼び出しの比較に使う。 */
const withoutTag = (argvs: readonly (readonly string[])[]): string[][] =>
  argvs.map((argv) =>
    argv.map((arg) => (arg.startsWith("--groups=") ? "--groups=*" : arg)),
  );

/** `dir`を`identity`の枠からrootへ戻すコマンドの並び。 */
function takeBackSequence(identity: CheckIdentity, dir: string): string[][] {
  return [
    gatherArgv(identity, dir),
    openDirsArgv(identity, dir),
    dropWriteBitsArgv(identity, dir),
    reclaimArgv(dir),
    leftoverArgv(dir),
  ];
}

function sandboxOf(
  deps: CheckSandboxDeps,
  extra?: {
    readonly maxWaitMs?: number;
    readonly pollMs?: number;
    readonly onSlotSkipped?: (skip: SlotSkip) => Promise<void>;
  },
) {
  return createCheckSandbox({ uids: POOL, deps, random: () => 0, ...extra });
}

/** 準備を終えた後に記録された呼び出しの数。`release`の呼び出しだけを見るために使う。 */
async function prepared(fake: ReturnType<typeof fakeSandboxDeps>) {
  const sandbox = sandboxOf(fake.deps);
  await sandbox.prepare(DIRS);
  return { sandbox, before: fake.calls.length };
}

describe("createCheckSandbox", () => {
  test("refuses to wrap a command before a slot is held", () => {
    const fake = fakeSandboxDeps();
    expect(() => sandboxOf(fake.deps).wrap(["bun", "test"])).toThrow(
      "no slot is held",
    );
  });

  test("wraps a command with setpriv for the held slot's uid", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps());
    expect(sandbox.wrap(["bun", "test"])).toContain("--reuid=20000");
  });

  test("ends the wrapped command with a -- separator", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps());
    expect(sandbox.wrap(["bun", "test"]).slice(-3)).toEqual([
      "--",
      "bun",
      "test",
    ]);
  });

  test("takes the next slot when the first one is held", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps({ busySlots: [0] }));
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

  test("prepare stops before handing over when the runtime directory cannot be locked down", async () => {
    const fake = fakeSandboxDeps();
    const deps: CheckSandboxDeps = {
      ...fake.deps,
      lockDownRuntimeDir: async () => {
        throw new Error("chmod failed");
      },
    };
    await sandboxOf(deps)
      .prepare(DIRS)
      .catch(() => {});
    expect(fake.calls).toEqual([]);
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

  test("prepare hands the worktree and then the home over last", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls).slice(-2)).toEqual([
      chownToArgv(SLOT0, DIRS.worktreeDir),
      chownToArgv(SLOT0, DIRS.homeDir),
    ]);
  });

  test("prepare hands over to the uid of the held slot", async () => {
    const fake = fakeSandboxDeps({ busySlots: [0] });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls.at(-1)?.argv).toContain("20001:20001");
  });

  test("prepare records the worktree and the home of the slot", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("prepare writes the record before handing anything over", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events.indexOf("record-write 0")).toBeLessThan(
      fake.events.indexOf(ran(chownToArgv(SLOT0, DIRS.worktreeDir))),
    );
  });

  test("prepare fails when the handover fails", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(chownToArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toThrow("denied");
  });

  test("masks a secret in the failure message", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(chownToArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail(`leaked ${secret}`)
          : undefined,
    });
    const message = await sandboxOf(fake.deps)
      .prepare(DIRS)
      .then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );
    expect(message).not.toContain(secret);
  });

  test("prepare takes back the worktree a dead run recorded in the slot", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls).slice(0, 5)).toEqual(
      takeBackSequence(SLOT0, OLD.worktreeDir),
    );
  });

  test("prepare removes the home a dead run recorded in the slot", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls[5]?.argv).toEqual(removeTreeArgv(OLD.homeDir));
  });

  test("prepare replaces the stale record with its own", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("prepare does not take back a recorded worktree that is gone", async () => {
    const fake = fakeSandboxDeps({
      records: { 0: OLD },
      pathKinds: { [OLD.worktreeDir]: "missing" },
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls)).not.toContainEqual(
      gatherArgv(SLOT0, OLD.worktreeDir),
    );
  });

  test.each([...SHARED_TMP_DIRS])(
    "prepare removes the slot uid's directories in %s",
    async (dir) => {
      const fake = fakeSandboxDeps();
      await sandboxOf(fake.deps).prepare(DIRS);
      expect(argvOf(fake.calls)).toContainEqual(purgeDirsArgv(20000, dir));
    },
  );

  test.each([...SHARED_TMP_DIRS])(
    "prepare removes the slot uid's files in %s",
    async (dir) => {
      const fake = fakeSandboxDeps();
      await sandboxOf(fake.deps).prepare(DIRS);
      expect(argvOf(fake.calls)).toContainEqual(purgeFilesArgv(20000, dir));
    },
  );

  test("prepare purges the shared directories before handing anything over", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(
      fake.events.indexOf(ran(remainingOfUidArgv(20000, "/dev/mqueue"))),
    ).toBeLessThan(fake.events.indexOf("record-write 0"));
  });

  test("prepare removes the IPC objects the slot uid owns or created", async () => {
    const fake = fakeSandboxDeps({
      ipc: [
        { kind: "shm", id: 7, uid: 20000, cuid: 20000 },
        { kind: "sem", id: 3, uid: 0, cuid: 20000 },
        { kind: "msg", id: 5, uid: 0, cuid: 0 },
      ],
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(
      setprivArgv(SLOT0, ["/usr/bin/ipcrm", "-m", "7", "-s", "3"]),
    );
  });

  test("prepare runs no ipcrm when the slot uid has no IPC object", async () => {
    const fake = fakeSandboxDeps({
      ipc: [{ kind: "shm", id: 7, uid: 20001, cuid: 20001 }],
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(
      fake.calls.filter((call) => call.argv.includes("/usr/bin/ipcrm")),
    ).toEqual([]);
  });

  test("prepare skips a slot whose processes cannot be stopped", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("prepare gives a skipped slot back before taking the next", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events.indexOf("release-slot 0")).toBeLessThan(
      fake.events.indexOf("acquire 1"),
    );
  });

  test("prepare reports a skipped slot", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    const skips: SlotSkip[] = [];
    await sandboxOf(fake.deps, {
      onSlotSkipped: async (skip) => {
        skips.push(skip);
      },
    }).prepare(DIRS);
    expect(skips.map((skip) => [skip.index, skip.uid])).toEqual([[0, 20000]]);
  });

  test("prepare keeps the record of a skipped slot", async () => {
    const fake = fakeSandboxDeps({
      stuck: { 50: 20000 },
      records: { 0: OLD },
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.records.get(0)).toEqual(OLD);
  });

  test("prepare fails when every slot has to be skipped", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000, 51: 20001 } });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toThrow(
      "no check slot could be used",
    );
  });

  test("prepare skips a slot whose files remain in a shared directory", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(remainingOfUidArgv(20000, "/tmp"))(argv)
          ? ok("/tmp/kept\n")
          : undefined,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("prepare skips a slot whose IPC objects remain", async () => {
    const fake = fakeSandboxDeps({
      ipc: [{ kind: "shm", id: 7, uid: 20000, cuid: 20000 }],
      ipcStuck: true,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("prepare skips a slot whose record cannot be read", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("prepare skips a slot whose recorded worktree cannot be taken back", async () => {
    const fake = fakeSandboxDeps({
      records: { 0: OLD },
      respond: (argv) =>
        matches(leftoverArgv(OLD.worktreeDir))(argv)
          ? ok(`${OLD.worktreeDir}/x\n`)
          : undefined,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("runs every tool from the root directory", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(
      fake.calls.filter((call) => call.options?.cwd !== "/").map((c) => c.argv),
    ).toEqual([]);
  });

  test("release after a failed prepare gives the slot back", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(chownToArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.events).toContain("release-slot 0");
  });

  test("release after a failed prepare takes the worktree back", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(chownToArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(
      gatherArgv(SLOT0, DIRS.worktreeDir),
    );
  });

  test("settle passes when no tagged process is left", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps());
    await expect(sandbox.settle()).resolves.toBeUndefined();
  });

  test("settle fails when a tagged process cannot be stopped", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_TAGGED);
    await expect(sandbox.settle()).rejects.toThrow("could not be stopped");
  });

  test("release takes the worktree back and then removes the home", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))).toEqual([
      ...takeBackSequence(SLOT0, DIRS.worktreeDir),
      removeTreeArgv(DIRS.homeDir),
    ]);
  });

  test("release never changes modes as root", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(
      fake.calls
        .filter((call) => call.argv.includes("/usr/bin/chmod"))
        .filter((call) => call.argv[0] !== SETPRIV_PATH),
    ).toEqual([]);
  });

  test("release clears the record after taking everything back", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(fake.events.slice(-2)).toEqual(["record-clear 0", "release-slot 0"]);
  });

  test("release does not take back a worktree that is gone", async () => {
    const fake = fakeSandboxDeps({
      pathKinds: { [DIRS.worktreeDir]: "missing" },
    });
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))).toEqual([
      removeTreeArgv(DIRS.homeDir),
    ]);
  });

  test("release fails when entries of others remain in the worktree", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(leftoverArgv(DIRS.worktreeDir))(argv)
          ? ok(`${DIRS.worktreeDir}/x\n`)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await expect(sandbox.release(DIRS)).rejects.toThrow("remain");
  });

  test("release keeps the record when entries remain", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(leftoverArgv(DIRS.worktreeDir))(argv)
          ? ok(`${DIRS.worktreeDir}/x\n`)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("release fails when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(gatherArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("busy", 1)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await expect(sandbox.release(DIRS)).rejects.toThrow("busy");
  });

  test("release still gives the slot back when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(gatherArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("busy", 1)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.events).toContain("release-slot 0");
  });

  test("release does not take ownership back while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_TAGGED);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.calls.length).toBe(before);
  });

  test("release keeps the record while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_TAGGED);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("release fails loudly while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_TAGGED);
    await expect(sandbox.release(DIRS)).rejects.toThrow("could not be stopped");
  });

  test("release still gives the slot back while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_TAGGED);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.events).toContain("release-slot 0");
  });

  test("release without a held slot does nothing", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).release(DIRS);
    expect(fake.calls).toEqual([]);
  });

  test("a second release does nothing", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    const before = fake.calls.length;
    await sandbox.release(DIRS);
    expect(fake.calls.length).toBe(before);
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
  const RECORDED = { 1: DIRS };

  test("returns false when no slot recorded the worktree", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(false);
  });

  test("runs nothing when no slot recorded the worktree", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.calls).toEqual([]);
  });

  test("takes back the worktree a slot recorded", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(withoutTag(argvOf(fake.calls).slice(0, 5))).toEqual(
      withoutTag(takeBackSequence(SLOT1, WT)),
    );
  });

  test("removes the recorded home", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.calls.at(-1)?.argv).toEqual(removeTreeArgv(DIRS.homeDir));
  });

  test("clears the record", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.records.has(1)).toBe(false);
  });

  test("returns true once it took the worktree back", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(true);
  });

  test("stops the processes a dead run left in that uid", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      processes: { 90: status({ uid: 20001, groups: [] }) },
    });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.killed).toEqual([90]);
  });

  test("holds the slot while it works and gives it back", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.events.at(-1)).toBe("release-slot 1");
  });

  test("does nothing when a live run holds the slot", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, busySlots: [1] });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100);
    expect(fake.calls).toEqual([]);
  });

  test("does not stop processes when a live run holds the slot", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      busySlots: [1],
      processes: { 90: status({ uid: 20001, groups: [] }) },
    });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100);
    expect(fake.killed).toEqual([]);
  });

  test("returns false when a live run holds the slot", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, busySlots: [1] });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps, 100)).toBe(false);
  });

  test("does nothing when the record changed before the slot was taken", async () => {
    const fake = fakeSandboxDeps({ records: { 0: DIRS } });
    let reads = 0;
    const deps: CheckSandboxDeps = {
      ...fake.deps,
      slotRecords: {
        ...fake.deps.slotRecords,
        read: async (index) => {
          reads += 1;
          return reads === 1 ? fake.deps.slotRecords.read(index) : OLD;
        },
      },
    };
    await restoreCheckOwnership(WT, [20001], deps);
    expect(fake.calls).toEqual([]);
  });

  test("ignores a slot whose record cannot be read", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, corruptRecords: [0] });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(true);
  });

  test("fails when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(gatherArgv(SLOT1, WT))(argv) ? fail("denied", 1) : undefined,
    });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      "denied",
    );
  });

  test("keeps the record when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(gatherArgv(SLOT1, WT))(argv) ? fail("denied", 1) : undefined,
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.records.get(1)).toEqual(DIRS);
  });

  test("gives the slot back when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(gatherArgv(SLOT1, WT))(argv) ? fail("denied", 1) : undefined,
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
