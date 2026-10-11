import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  aclLeftoverArgv,
  acquireSlot,
  CHECK_ENV_KEYS,
  CHECK_IMAGE_STALE_REASON,
  CHECK_NPROC_LIMIT,
  CHECK_RUNTIME_UNSAFE_REASON,
  type CheckDirs,
  type CheckEnvironmentError,
  type CheckEnvironmentProblems,
  type CheckIdentity,
  CheckImageStaleError,
  CheckOwnershipRestoreError,
  CheckRuntimeUnsafeError,
  type CheckSandboxDeps,
  CheckSlotInUseError,
  type CheckSlotNotice,
  CheckSlotsBusyError,
  checkEnv,
  checkEnvironmentError,
  checkImageGate,
  checkImageProblems,
  chownToArgv,
  createCheckSandbox,
  DEFAULT_CHECK_UID,
  DEFAULT_POOL_SIZE,
  defaultSandboxDeps,
  dropWriteBitsArgv,
  formatSlotRecord,
  gatherArgv,
  handOverArgv,
  hardLinkedArgv,
  type IpcEntry,
  ipcrmArgv,
  isCheckEnvironmentReason,
  kernelWarningText,
  killAllArgv,
  leftoverArgv,
  listWorldWritablePaths,
  newCheckIdentity,
  notRootOwnedArgv,
  openDirsArgv,
  PRLIMIT_PATH,
  parseCheckUid,
  parsePasswdUsers,
  parsePoolSize,
  parseProcStatus,
  parseSlotRecord,
  parseSysvIpc,
  purgeDirsArgv,
  purgeFilesArgv,
  REAP_MAX_WAIT_MS,
  REQUIRED_TOOL_PATHS,
  type ReapDeps,
  reapUidProcesses,
  reclaimArgv,
  reclaimBulkArgv,
  remainingOfUidArgv,
  removeAclArgv,
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
  slotRecordUnreadableNoticeText,
  slotSkipNoticeText,
  sweepLinksArgv,
  symlinksArgv,
  UnreadableSlotRecordError,
  WINDMILL_TMP_DIR,
  worldWritablePathsArgv,
} from "../../f/factory/lib/check_sandbox.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type {
  CommandResult,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, ok, timeout } from "./testSupport.ts";

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

describe("handOverArgv", () => {
  const argv = handOverArgv(IDENTITY, DIRS.worktreeDir);

  test("descends in one chown without following symlinks", () => {
    expect(argv.slice(0, 4)).toEqual(["/usr/bin/chown", "-R", "-P", "-h"]);
  });

  test("hands over only entries that root owns", () => {
    expect(argv).toContain("--from=0:0");
  });

  test("hands over to the check uid and gid", () => {
    expect(argv).toContain("10001:10001");
  });

  test("ends with the directory after a separator", () => {
    expect(argv.slice(-2)).toEqual(["--", DIRS.worktreeDir]);
  });

  test("refuses a top-level directory", () => {
    expect(() => handOverArgv(IDENTITY, "/workspaces")).toThrow();
  });
});

describe("hardLinkedArgv", () => {
  test("looks for non-directories with more than one link and stops at the first", () => {
    expect(hardLinkedArgv(DIRS.worktreeDir).join(" ")).toBe(
      `/usr/bin/find -P ${DIRS.worktreeDir} ! -type d -links +1 -print -quit`,
    );
  });

  test("does not stay on one filesystem, as the bulk chown does not", () => {
    expect(hardLinkedArgv(DIRS.worktreeDir)).not.toContain("-xdev");
  });

  test("refuses a top-level directory", () => {
    expect(() => hardLinkedArgv("/workspaces")).toThrow();
  });
});

describe("reclaimBulkArgv", () => {
  const argv = reclaimBulkArgv(IDENTITY, DIRS.worktreeDir);

  test("descends in one chown without following symlinks", () => {
    expect(argv.slice(0, 4)).toEqual(["/usr/bin/chown", "-R", "-P", "-h"]);
  });

  test("selects the entries of the check uid whatever their group", () => {
    expect(argv).toContain("--from=10001");
  });

  test("gives them to root", () => {
    expect(argv.slice(-3)).toEqual(["0:0", "--", DIRS.worktreeDir]);
  });

  test("refuses a top-level directory", () => {
    expect(() => reclaimBulkArgv(IDENTITY, "/workspaces")).toThrow();
  });
});

describe("sweepLinksArgv", () => {
  test("deletes the symlinks whose content is absolute or contains ..", () => {
    expect(sweepLinksArgv(DIRS.worktreeDir).join(" ")).toBe(
      `/usr/bin/find -P ${DIRS.worktreeDir} -type l ( -lname /* -o -lname *..* ) -delete`,
    );
  });

  test("refuses a top-level directory", () => {
    expect(() => sweepLinksArgv("/workspaces")).toThrow();
  });
});

describe("symlinksArgv", () => {
  test("lists symlinks without following them", () => {
    expect(symlinksArgv(DIRS.worktreeDir).join(" ")).toBe(
      `/usr/bin/find -P ${DIRS.worktreeDir} -type l -print0`,
    );
  });

  test("refuses a top-level directory", () => {
    expect(() => symlinksArgv("/workspaces")).toThrow();
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
      "( ! -uid 0 -o ( ! -type l -perm /6022 ) )",
    );
  });

  test("counts a loose file however many hard links it has", () => {
    expect(argv).not.toContain("-links");
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

describe("aclLeftoverArgv", () => {
  test("lists the entries with extended ACLs without following symlinks", () => {
    expect(aclLeftoverArgv(DIRS.worktreeDir)).toEqual([
      "/usr/bin/getfacl",
      "-R",
      "-P",
      "-s",
      "-p",
      "--",
      DIRS.worktreeDir,
    ]);
  });

  test("refuses a top-level directory", () => {
    expect(() => aclLeftoverArgv("/workspaces")).toThrow();
  });
});

describe("removeAclArgv", () => {
  test("removes the ACLs of every entry but symlinks, from the parent directory", () => {
    expect(removeAclArgv(DIRS.worktreeDir)).toEqual([
      "/usr/bin/find",
      "-P",
      DIRS.worktreeDir,
      "-xdev",
      "!",
      "-type",
      "l",
      "-execdir",
      "/usr/bin/setfacl",
      "-b",
      "-k",
      "{}",
      "+",
    ]);
  });

  test("refuses a top-level directory", () => {
    expect(() => removeAclArgv("/workspaces")).toThrow();
  });
});

describe("shared temporary directories", () => {
  test("cover /tmp, /var/tmp, /dev/shm, the POSIX message queues and /run/lock", () => {
    expect(SHARED_TMP_DIRS).toEqual([
      "/tmp",
      "/var/tmp",
      "/dev/shm",
      "/dev/mqueue",
      "/run/lock",
    ]);
  });

  test("world-writable paths are listed from the root and /dev/shm without crossing mounts, counting everything under the base image's open paths and only root's open directories in the shared ones", () => {
    expect(worldWritablePathsArgv().join(" ")).toBe(
      "/usr/bin/find -P / /dev/shm -xdev -path /tmp/windmill -prune -o ! -type l -perm -0002 ! ( -path /tmp -o -path /var/tmp -o -path /run/lock -o -path /dev/shm ) ( -path /usr/src/app -o -path /usr/src/app/* -o -path /tmp/.cache -o -path /tmp/.cache/* -o ! ( -path /tmp/* -o -path /var/tmp/* -o -path /run/lock/* -o -path /dev/shm/* ) -o ( -uid 0 -type d ! -perm -1000 ) ) -print",
    );
  });

  test("the operations guide gives the same listing as a command to run in the worker", () => {
    const quoted = worldWritablePathsArgv()
      .map((arg) => (/^[\w./=:-]+$/.test(arg) ? arg : `'${arg}'`))
      .join(" ");
    const guide = readFileSync(
      join(import.meta.dir, "../../docs/operations.md"),
      "utf8",
    ).replace(/ \\\n\s*/g, " ");
    expect(guide).toContain(`exec windmill_worker ${quoted}`);
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

describe("the slot record files", () => {
  const tempDirs: string[] = [];
  const lockDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "factory-check-slots-"));
    tempDirs.push(dir);
    return join(dir, "slots");
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a record through the file", async () => {
    const records = defaultSandboxDeps(lockDir()).slotRecords;
    await records.write(0, DIRS);
    expect(await records.read(0)).toEqual(DIRS);
  });

  test("reading a record that does not parse throws UnreadableSlotRecordError", async () => {
    const dir = lockDir();
    const records = defaultSandboxDeps(dir).slotRecords;
    await records.write(0, DIRS);
    writeFileSync(join(dir, "slot-0.state"), "{");
    await expect(records.read(0)).rejects.toBeInstanceOf(
      UnreadableSlotRecordError,
    );
  });

  test("the error for a record that does not parse names the record's path", async () => {
    const dir = lockDir();
    const records = defaultSandboxDeps(dir).slotRecords;
    await records.write(0, DIRS);
    writeFileSync(join(dir, "slot-0.state"), "{");
    await expect(records.read(0)).rejects.toThrow(join(dir, "slot-0.state"));
  });

  test("setting a record aside leaves no record behind", async () => {
    const dir = lockDir();
    const records = defaultSandboxDeps(dir).slotRecords;
    await records.write(0, DIRS);
    writeFileSync(join(dir, "slot-0.state"), "{");
    await records.setAside(0);
    expect(await records.read(0)).toBeNull();
  });

  test("setting a record aside keeps its text at the returned path", async () => {
    const dir = lockDir();
    const records = defaultSandboxDeps(dir).slotRecords;
    await records.write(0, DIRS);
    writeFileSync(join(dir, "slot-0.state"), "{");
    const path = await records.setAside(0);
    expect(readFileSync(path, "utf8")).toBe("{");
  });

  test("setting a record aside twice keeps both texts", async () => {
    const dir = lockDir();
    const records = defaultSandboxDeps(dir).slotRecords;
    await records.write(0, DIRS);
    writeFileSync(join(dir, "slot-0.state"), "first");
    const first = await records.setAside(0);
    writeFileSync(join(dir, "slot-0.state"), "second");
    await records.setAside(0);
    expect(existsSync(first)).toBe(true);
  });
});

describe("slotRecordUnreadableNoticeText", () => {
  const text = slotRecordUnreadableNoticeText({
    index: 2,
    uid: 10003,
    path: "/var/lib/factory/check-slots/slot-2.state.corrupt-1",
  });

  test("names the slot and its uid", () => {
    expect(text).toContain("factory-check-2(uid 10003)");
  });

  test("names where the record was moved", () => {
    expect(text).toContain("slot-2.state.corrupt-1");
  });

  test("tells the operator to check the worktree the record named", () => {
    expect(text).toContain("rootに戻");
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

/**
 * 時間とともに消えるプロセス表の偽物。`killAll`は、そのuidの生きたプロセスをすべて消す。
 * `sleep`の分だけ時計を進める。
 */
function fakeReapDeps(table: Record<number, string>) {
  const live = new Map<number, string>(
    Object.entries(table).map(([pid, text]) => [Number(pid), text]),
  );
  const killed: number[] = [];
  const signalled: number[] = [];
  let clock = 0;
  const deps: ReapDeps = {
    listPids: async () => [...live.keys()],
    readStatus: async (pid) => live.get(pid) ?? null,
    killAll: async (uid) => {
      signalled.push(uid);
      for (const [pid, text] of live) {
        if (parseProcStatus(text)?.uid !== uid) continue;
        killed.push(pid);
        live.delete(pid);
      }
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, killed, signalled, live, elapsed: () => clock };
}

describe("killAllArgv", () => {
  test("sends SIGKILL to every process of the uid as that uid", () => {
    expect(killAllArgv(10001)).toEqual([
      SETPRIV_PATH,
      "--reuid=10001",
      "--regid=10001",
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--no-new-privs",
      "--",
      "/usr/bin/kill",
      "-9",
      "--",
      "-1",
    ]);
  });

  test("refuses to act as root", () => {
    expect(() => killAllArgv(0)).toThrow("refusing to act as uid 0");
  });

  test("refuses a system uid below 1000", () => {
    expect(() => killAllArgv(999)).toThrow("refusing to act as uid 999");
  });

  test("refuses a uid that is not an integer", () => {
    expect(() => killAllArgv(10001.5)).toThrow("refusing to act as uid");
  });
});

describe("setprivArgv's uid check", () => {
  test("refuses to switch to root", () => {
    expect(() =>
      setprivArgv({ uid: 0, gid: 0, tagGid: 424242 }, ["true"]),
    ).toThrow("refusing to act as uid 0");
  });
});

describe("checkImageProblems", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "factory-check-0:x:20000:20000::/home/factory-check-0:/usr/sbin/nologin",
    "factory-check-1:x:20001:20001::/home/factory-check-1:/usr/sbin/nologin",
    "",
  ].join("\n");
  const image = (opts?: {
    readonly missing?: readonly string[];
    readonly passwd?: string | null;
    readonly worldWritable?: readonly string[] | null;
  }) => ({
    listWorldWritablePaths: async () => {
      const paths = opts?.worldWritable === undefined ? [] : opts.worldWritable;
      if (paths === null) throw new Error("listing timed out");
      return paths;
    },
    isExecutable: async (path: string) => !(opts?.missing ?? []).includes(path),
    readPasswd: async () => {
      const text = opts?.passwd === undefined ? passwd : opts.passwd;
      if (text === null) throw new Error("EACCES");
      return text;
    },
  });

  test("finds nothing on an image that has every tool and user", async () => {
    expect(await checkImageProblems([20000, 20001], image())).toEqual({
      image: [],
      runtime: [],
    });
  });

  test.each([...REQUIRED_TOOL_PATHS])("reports a missing %s", async (path) => {
    expect(
      (await checkImageProblems([20000], image({ missing: [path] }))).image,
    ).toEqual([`${path} is missing`]);
  });

  test("reports the uids no numbered check user has", async () => {
    expect(
      (await checkImageProblems([20000, 20002, 20003], image())).image,
    ).toEqual(["no factory-check-N user for uid 20002, 20003"]);
  });

  test("does not count the unnumbered user of an older image", async () => {
    expect(
      (
        await checkImageProblems(
          [10001],
          image({
            passwd:
              "factory-check:x:10001:10001::/home/factory-check:/usr/sbin/nologin\n",
          }),
        )
      ).image,
    ).toEqual(["no factory-check-N user for uid 10001"]);
  });

  test("reports a directory the base image leaves open as an image problem", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/usr/src/app"] }),
        )
      ).image,
    ).toEqual(["world-writable paths the image leaves open: /usr/src/app"]);
  });

  test("reports /tmp/.cache left open as an image problem", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/tmp/.cache"] }),
        )
      ).image,
    ).toEqual(["world-writable paths the image leaves open: /tmp/.cache"]);
  });

  // ベースのイメージが開いているのはディレクトリそのものだけで、その下にできたものは稼働中にできたものである。
  test.each(["/usr/src/app/windmill", "/tmp/.cache/bun"])(
    "reports %s, under a directory the base image opens, as a runtime problem",
    async (path) => {
      expect(
        (await checkImageProblems([20000], image({ worldWritable: [path] })))
          .runtime,
      ).toEqual([`world-writable paths created at runtime: ${path}`]);
    },
  );

  test.each(["/usr/src/app/windmill", "/tmp/.cache/bun"])(
    "does not blame the image for %s, under a directory the base image opens",
    async (path) => {
      expect(
        (await checkImageProblems([20000], image({ worldWritable: [path] })))
          .image,
      ).toEqual([]);
    },
  );

  test("keeps the base image's directory and what was created under it apart", async () => {
    expect(
      await checkImageProblems(
        [20000],
        image({ worldWritable: ["/usr/src/app", "/usr/src/app/planted"] }),
      ),
    ).toEqual({
      image: ["world-writable paths the image leaves open: /usr/src/app"],
      runtime: [
        "world-writable paths created at runtime: /usr/src/app/planted",
      ],
    });
  });

  test("does not count a path that only shares a prefix with a base image directory", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/usr/src/application"] }),
        )
      ).image,
    ).toEqual([]);
  });

  test("reports a path opened while the worker runs as a runtime problem", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/tmp/open"] }),
        )
      ).runtime,
    ).toEqual(["world-writable paths created at runtime: /tmp/open"]);
  });

  test("does not count a path opened while the worker runs as an image problem", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/tmp/open"] }),
        )
      ).image,
    ).toEqual([]);
  });

  test("lists at most ten runtime paths and counts the rest", async () => {
    const paths = Array.from(
      { length: 12 },
      (_, index) => `/tmp/open-${String(index)}`,
    );
    expect(
      (await checkImageProblems([20000], image({ worldWritable: paths })))
        .runtime,
    ).toEqual([
      `world-writable paths created at runtime: ${paths.slice(0, 10).join(", ")} and 2 more`,
    ]);
  });

  // 深い下のものが多くても、マウントポイントのような浅いパスを件数に隠さない。
  test("lists shallower runtime paths first so a mount point is not hidden", async () => {
    const deep = Array.from(
      { length: 11 },
      (_, index) => `/tmp/.cache/bun/install/file-${String(index)}`,
    );
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: [...deep, "/workspaces"] }),
        )
      ).runtime,
    ).toEqual([
      `world-writable paths created at runtime: /workspaces, ${deep.slice(0, 9).join(", ")} and 2 more`,
    ]);
  });

  test("keeps a path from splitting the reason", async () => {
    expect(
      (
        await checkImageProblems(
          [20000],
          image({ worldWritable: ["/tmp/a; b"] }),
        )
      ).runtime.join(""),
    ).not.toContain("; ");
  });

  test("reports paths that cannot be listed as a runtime problem with the cause", async () => {
    expect(
      (await checkImageProblems([20000], image({ worldWritable: null })))
        .runtime,
    ).toEqual(["world-writable paths could not be listed: listing timed out"]);
  });

  test("reports an unreadable passwd", async () => {
    expect(
      (await checkImageProblems([20000], image({ passwd: null }))).image,
    ).toContain("/etc/passwd is unreadable");
  });
});

describe("listWorldWritablePaths", () => {
  test("lists the paths find printed", async () => {
    const fake = createFakeCommandRunner([ok("/tmp/open\n/etc/open\n")]);
    expect(await listWorldWritablePaths(fake.run)).toEqual([
      "/tmp/open",
      "/etc/open",
    ]);
  });

  test("runs the listing as root from /", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await listWorldWritablePaths(fake.run);
    expect(fake.calls[0]?.argv).toEqual(worldWritablePathsArgv());
  });

  test("keeps the paths when find exits with 1 for entries that vanished during the walk", async () => {
    const fake = createFakeCommandRunner([
      { ...fail("No such file or directory", 1), stdout: "/tmp/open\n" },
    ]);
    expect(await listWorldWritablePaths(fake.run)).toEqual(["/tmp/open"]);
  });

  // /dev/shmが無い環境では、findが起点の欠落をstderrに出して1で終わる。エラー行をパスとして扱わない。
  test("ignores the error find prints for a missing /dev/shm", async () => {
    const fake = createFakeCommandRunner([
      {
        ...fail("/usr/bin/find: '/dev/shm': No such file or directory\n", 1),
        stdout: "/tmp/open\n",
      },
    ]);
    expect(await listWorldWritablePaths(fake.run)).toEqual(["/tmp/open"]);
  });

  test("fails when find exits with another code", async () => {
    const fake = createFakeCommandRunner([fail("find: invalid predicate", 2)]);
    await expect(listWorldWritablePaths(fake.run)).rejects.toThrow(
      "listing world-writable paths failed (exit 2)",
    );
  });

  test("fails when find was killed by a signal", async () => {
    const fake = createFakeCommandRunner([fail("", 137)]);
    await expect(listWorldWritablePaths(fake.run)).rejects.toThrow("exit 137");
  });

  test("fails when the listing timed out", async () => {
    const fake = createFakeCommandRunner([timeout()]);
    await expect(listWorldWritablePaths(fake.run)).rejects.toThrow(
      "listing world-writable paths timed out",
    );
  });

  test("fails when find cannot be started", async () => {
    const fake = createFakeCommandRunner([new Error("ENOENT")]);
    await expect(listWorldWritablePaths(fake.run)).rejects.toThrow("ENOENT");
  });
});

describe("checkEnvironmentError", () => {
  test("returns nothing when the image and the runtime are ready", () => {
    expect(checkEnvironmentError({ image: [], runtime: [] })).toBeNull();
  });

  test("blames the image when the image misses something", () => {
    expect(
      checkEnvironmentError({
        image: ["/usr/bin/getfacl is missing"],
        runtime: [],
      }),
    ).toBeInstanceOf(CheckImageStaleError);
  });

  test("lists the runtime problems too when it blames the image", () => {
    expect(
      checkEnvironmentError({
        image: ["/usr/bin/getfacl is missing"],
        runtime: ["world-writable paths created at runtime: /tmp/open"],
      })?.problems,
    ).toEqual([
      "/usr/bin/getfacl is missing",
      "world-writable paths created at runtime: /tmp/open",
    ]);
  });

  test("keeps the image problems of a stale image apart", () => {
    const error = checkEnvironmentError({
      image: ["/usr/bin/getfacl is missing"],
      runtime: ["world-writable paths created at runtime: /workspaces"],
    });
    expect(
      error instanceof CheckImageStaleError ? error.imageProblems : null,
    ).toEqual(["/usr/bin/getfacl is missing"]);
  });

  test("keeps the runtime problems found with a stale image apart, so that they get their own notice", () => {
    const error = checkEnvironmentError({
      image: ["/usr/bin/getfacl is missing"],
      runtime: ["world-writable paths created at runtime: /workspaces"],
    });
    expect(
      error instanceof CheckImageStaleError ? error.runtimeProblems : null,
    ).toEqual(["world-writable paths created at runtime: /workspaces"]);
  });

  test("blames the runtime when only the running worker has a problem", () => {
    expect(
      checkEnvironmentError({
        image: [],
        runtime: ["world-writable paths created at runtime: /tmp/open"],
      }),
    ).toBeInstanceOf(CheckRuntimeUnsafeError);
  });
});

describe("checkImageGate", () => {
  /** 確かめた回数と知らせた例外を記録する、`checkImageGate`の依存。 */
  function gate(problems: CheckEnvironmentProblems) {
    const reported: CheckEnvironmentError[] = [];
    const seen = { checks: 0, reported };
    return {
      seen,
      deps: {
        problems: async () => {
          seen.checks += 1;
          return problems;
        },
        report: async (error: CheckEnvironmentError) => {
          seen.reported.push(error);
        },
      },
    };
  }
  const STALE: CheckEnvironmentProblems = {
    image: ["/usr/bin/getfacl is missing"],
    runtime: [],
  };
  const RUNTIME: CheckEnvironmentProblems = {
    image: [],
    runtime: ["world-writable paths created at runtime: /tmp/open"],
  };

  test("does not look at the image when there are no check commands", async () => {
    const g = gate(STALE);
    await checkImageGate(false, g.deps);
    expect(g.seen.checks).toBe(0);
  });

  test("lets a run without check commands go on", async () => {
    const g = gate(STALE);
    expect(await checkImageGate(false, g.deps)).toBeNull();
  });

  test("lets a run go on when the image can run the checks", async () => {
    const g = gate({ image: [], runtime: [] });
    expect(await checkImageGate(true, g.deps)).toBeNull();
  });

  test("stops with the stale image as the reason", async () => {
    const g = gate(STALE);
    expect(await checkImageGate(true, g.deps)).toBe(
      `${CHECK_IMAGE_STALE_REASON}: /usr/bin/getfacl is missing`,
    );
  });

  test("reports the stale image once", async () => {
    const g = gate(STALE);
    await checkImageGate(true, g.deps);
    expect(g.seen.reported.map((error) => error.message)).toEqual([
      `${CHECK_IMAGE_STALE_REASON}: /usr/bin/getfacl is missing`,
    ]);
  });

  test("stops with the runtime problem as the reason", async () => {
    const g = gate(RUNTIME);
    expect(await checkImageGate(true, g.deps)).toBe(
      `${CHECK_RUNTIME_UNSAFE_REASON}: world-writable paths created at runtime: /tmp/open`,
    );
  });

  test("reports a runtime problem as such", async () => {
    const g = gate(RUNTIME);
    await checkImageGate(true, g.deps);
    expect(g.seen.reported[0]).toBeInstanceOf(CheckRuntimeUnsafeError);
  });
});

describe("CheckImageStaleError", () => {
  test("starts with the reason that tells the operator to run mise run up", () => {
    expect(
      new CheckImageStaleError(["/usr/bin/getfacl is missing"]).message,
    ).toBe(`${CHECK_IMAGE_STALE_REASON}: /usr/bin/getfacl is missing`);
  });

  test("joins the problems without the reason separator", () => {
    expect(new CheckImageStaleError(["a", "b"]).message).not.toContain("; ");
  });

  test("lists the runtime problems after the image problems", () => {
    expect(new CheckImageStaleError(["a"], ["b"]).problems).toEqual(["a", "b"]);
  });

  test("has no runtime problems unless given", () => {
    expect(new CheckImageStaleError(["a"]).runtimeProblems).toEqual([]);
  });
});

describe("CheckRuntimeUnsafeError", () => {
  test("starts with the reason that tells the operator to close the paths or recreate the worker", () => {
    expect(new CheckRuntimeUnsafeError(["x"]).message).toBe(
      `${CHECK_RUNTIME_UNSAFE_REASON}: x`,
    );
  });

  test("is not a stale image", () => {
    expect(new CheckRuntimeUnsafeError(["x"])).not.toBeInstanceOf(
      CheckImageStaleError,
    );
  });
});

describe("isCheckEnvironmentReason", () => {
  test("recognizes a stale image", () => {
    expect(
      isCheckEnvironmentReason(new CheckImageStaleError(["x"]).message),
    ).toBe(true);
  });

  test("recognizes a runtime problem", () => {
    expect(
      isCheckEnvironmentReason(new CheckRuntimeUnsafeError(["x"]).message),
    ).toBe(true);
  });

  test("does not take a busy worktree for an environment problem", () => {
    expect(
      isCheckEnvironmentReason(
        "worktree is still used by processes from an earlier run",
      ),
    ).toBe(false);
  });
});

describe("notRootOwnedArgv", () => {
  test("prints the first entry that root does not own", () => {
    expect(notRootOwnedArgv("/workspaces/acme/widgets/wt-1")).toEqual([
      "/usr/bin/find",
      "-P",
      "/workspaces/acme/widgets/wt-1",
      "-xdev",
      "!",
      "-uid",
      "0",
      "-print",
      "-quit",
    ]);
  });
});

describe("reapUidProcesses", () => {
  test("signals every process of the slot uid at once", async () => {
    const fake = fakeReapDeps({ 50: status({}), 51: status({ groups: [] }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.killed).toEqual([50, 51]);
  });

  test("signals as the slot uid", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.signalled).toEqual([IDENTITY.uid]);
  });

  test("leaves a process of another uid alone", async () => {
    const fake = fakeReapDeps({ 50: status({ uid: 10002 }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.killed).toEqual([]);
  });

  test("sends nothing when no process of the uid is left", async () => {
    const fake = fakeReapDeps({});
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.signalled).toEqual([]);
  });

  test("does not count a zombie", async () => {
    const fake = fakeReapDeps({ 50: status({ state: "Z (zombie)" }) });
    await reapUidProcesses(IDENTITY.uid, fake.deps);
    expect(fake.signalled).toEqual([]);
  });

  test("returns no remaining pid once everything is gone", async () => {
    const fake = fakeReapDeps({ 50: status({}), 51: status({}) });
    expect(await reapUidProcesses(IDENTITY.uid, fake.deps)).toEqual([]);
  });

  test("keeps signalling while the processes fork new ones", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    let forks = 0;
    const deps: ReapDeps = {
      ...fake.deps,
      killAll: async (uid) => {
        await fake.deps.killAll(uid);
        // 止める間に子を作るプロセス(fork爆弾)を、20回まで真似る。
        if (forks < 20) {
          forks += 1;
          fake.live.set(100 + forks, status({}));
        }
      },
    };
    expect(await reapUidProcesses(IDENTITY.uid, deps)).toEqual([]);
  });

  test("reports a process that survives until the deadline", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    const deps: ReapDeps = { ...fake.deps, killAll: async () => {} };
    expect(await reapUidProcesses(IDENTITY.uid, deps)).toEqual([50]);
  });

  test("gives up on a surviving process only after the deadline", async () => {
    const fake = fakeReapDeps({ 50: status({}) });
    const deps: ReapDeps = { ...fake.deps, killAll: async () => {} };
    await reapUidProcesses(IDENTITY.uid, deps);
    expect(fake.elapsed()).toBeGreaterThanOrEqual(REAP_MAX_WAIT_MS);
  });

  test("ignores a pid that vanished while listing", async () => {
    const fake = fakeReapDeps({});
    const deps: ReapDeps = { ...fake.deps, listPids: async () => [77] };
    expect(await reapUidProcesses(IDENTITY.uid, deps)).toEqual([]);
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
  /** イメージに無い道具の絶対パス。 */
  readonly missingTools?: readonly string[];
  /** `/etc/passwd`の本文。既定は枠0と枠1のユーザーを持つ。 */
  readonly passwd?: string;
  /** 記録を読むと、形の違いではない例外になる枠。 */
  readonly failingRecordReads?: readonly number[];
  /** 誰でも書き込めるパスとして見つかるもの。 */
  readonly worldWritable?: readonly string[];
  /** worktreeにあるsymlink。パスから、中身と`realpath`の結果(先が無ければnull)への対応。 */
  readonly symlinks?: Record<
    string,
    { readonly content: string; readonly resolved: string | null }
  >;
  /** ハードリンクのあるファイルとして見つかるパス。 */
  readonly hardLinked?: string;
  /** `realPath`を差し替える。undefinedを返したパスは、symlinkの表か、正規化したパスそのものとして答える。 */
  readonly realPathOf?: (path: string) => string | null | undefined;
  /** `realPath`が投げる例外のあるパス。 */
  readonly realPathFails?: string;
  /** symlinkを列挙するコマンドを失敗させる。 */
  readonly failSymlinkListing?: boolean;
  /** `readLink`が読めない(ENOENT)パス。 */
  readonly unreadablePaths?: readonly string[];
  /** `removeLink`が失敗するパス。 */
  readonly removeFails?: string;
  /** symlinkの一覧の出力の末尾に足す文字列。 */
  readonly listingTail?: string;
}) {
  const removedLinks: string[] = [];
  const symlinks = new Map(Object.entries(opts?.symlinks ?? {}));
  const events: string[] = [];
  const calls: FakeCall[] = [];
  let imageChecks = 0;
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
  const corrupt = new Set<number>(opts?.corruptRecords ?? []);
  const notices: CheckSlotNotice[] = [];
  let reapClock = 0;
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
      const responded = opts?.respond?.(argv);
      if (responded !== undefined) return responded;
      if (argv.includes("-print0") && opts?.failSymlinkListing === true)
        return fail("listing failed", 1);
      if (argv.includes("-print0"))
        return ok(
          [...symlinks.keys()].map((path) => `${path}\0`).join("") +
            (opts?.listingTail ?? ""),
        );
      if (argv.includes("-links") && argv.includes("+1"))
        return ok(opts?.hardLinked ?? "");
      return ok();
    },
    reap: {
      listPids: async () => [...live.keys(), ...stuck.keys()],
      readStatus: async (pid) => {
        const found = live.get(pid);
        if (found !== undefined) return found;
        const uid = stuck.get(pid);
        return uid === undefined ? null : status({ uid, groups: [1_000_000] });
      },
      killAll: async (uid) => {
        events.push(`kill-all ${String(uid)}`);
        for (const [pid, text] of live) {
          if (parseProcStatus(text)?.uid !== uid) continue;
          killed.push(pid);
          live.delete(pid);
        }
      },
      sleep: async (ms) => {
        reapClock += ms;
      },
      now: () => reapClock,
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
        if (opts?.failingRecordReads?.includes(index) === true)
          throw new Error("EIO: i/o error");
        if (corrupt.has(index))
          throw new UnreadableSlotRecordError(
            index,
            `/var/lib/factory/check-slots/slot-${String(index)}.state`,
          );
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
      setAside: async (index) => {
        events.push(`record-set-aside ${String(index)}`);
        corrupt.delete(index);
        records.delete(index);
        return `/var/lib/factory/check-slots/slot-${String(index)}.state.corrupt-1`;
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
    readLink: async (path) => {
      const found = symlinks.get(path);
      if (opts?.unreadablePaths?.includes(path) === true)
        throw Object.assign(new Error("ENOENT: no such file"), {
          code: "ENOENT",
        });
      if (found === undefined)
        throw Object.assign(new Error("EINVAL: not a symlink"), {
          code: "EINVAL",
        });
      return found.content;
    },
    realPath: async (path) => {
      if (path === opts?.realPathFails) throw new Error("EACCES: denied");
      const overridden = opts?.realPathOf?.(path);
      if (overridden !== undefined) return overridden;
      return symlinks.has(path)
        ? (symlinks.get(path)?.resolved ?? null)
        : resolve(path);
    },
    removeLink: async (path) => {
      if (path === opts?.removeFails)
        throw Object.assign(new Error(`EPERM: ${path}`), { code: "EPERM" });
      removedLinks.push(path);
      symlinks.delete(path);
    },
    replaceLink: async (path, content) => {
      symlinks.set(path, { content, resolved: content });
    },
    listWorldWritablePaths: async () => opts?.worldWritable ?? [],
    isExecutable: async (path) => {
      imageChecks += 1;
      return !(opts?.missingTools ?? []).includes(path);
    },
    readPasswd: async () =>
      opts?.passwd ??
      [
        "factory-check-0:x:20000:20000::/:/usr/sbin/nologin",
        "factory-check-1:x:20001:20001::/:/usr/sbin/nologin",
        "",
      ].join("\n"),
  };
  const onNotice = async (notice: CheckSlotNotice): Promise<void> => {
    notices.push(notice);
  };
  return {
    deps,
    events,
    calls,
    killed,
    records,
    notices,
    onNotice,
    symlinks,
    removedLinks,
    imageChecks: () => imageChecks,
  };
}

const POOL = [20000, 20001];
const SLOT0 = newCheckIdentity(20000, () => 0);
const SLOT1 = newCheckIdentity(20001, () => 0);
const OLD: SlotRecord = {
  worktreeDir: "/workspaces/acme/other/wt-9",
  homeDir: "/tmp/factory-check-home-old",
};

/** 止めても消えない、枠0のuidのプロセスだけがいる`ReapDeps`の差し替え。 */
const STUCK_PROCESS: Partial<ReapDeps> = {
  listPids: async () => [50],
  readStatus: async () => status({ uid: 20000, groups: [1_000_000] }),
  killAll: async () => {},
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
    reclaimBulkArgv(identity, dir),
    reclaimArgv(dir),
    leftoverArgv(dir),
    aclLeftoverArgv(dir),
  ];
}

const TAKE_BACK_LENGTH = takeBackSequence(IDENTITY, DIRS.worktreeDir).length;

/** `dir`のACLを探す1回目だけ見つかったと答え、2回目からは無いと答える`respond`。 */
function aclFoundOnce(dir: string) {
  let looks = 0;
  return (argv: readonly string[]): CommandResult | undefined => {
    if (!matches(aclLeftoverArgv(dir))(argv)) return undefined;
    looks += 1;
    return looks === 1 ? ok(`# file: ${dir}/shared\n`) : ok("");
  };
}

function sandboxOf(
  deps: CheckSandboxDeps,
  extra?: {
    readonly maxWaitMs?: number;
    readonly pollMs?: number;
    readonly onNotice?: (notice: CheckSlotNotice) => Promise<void>;
    readonly log?: ReturnType<typeof logger>;
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

describe("escapingSymlinks", () => {
  const WT = DIRS.worktreeDir;
  const PARENT = WT.slice(0, WT.lastIndexOf("/"));
  const OUT = { content: "/etc/passwd", resolved: "/etc/passwd" };

  /** 準備を終えたサンドボックスを返す。 */
  async function preparedWith(opts?: Parameters<typeof fakeSandboxDeps>[0]) {
    const fake = fakeSandboxDeps(opts);
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    return { fake, sandbox };
  }

  test("removes a symlink the check placed that points outside", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/node_modules/.bin/evil`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/node_modules/.bin/evil`,
    ]);
  });

  test("does not call a removed symlink a problem", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/.venv/bin/python3`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toEqual([]);
  });

  test("unlinks the symlink it reports", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/evil`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.removedLinks).toEqual([`${WT}/evil`]);
  });

  test("ignores a symlink that points inside the worktree", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/a`, { content: "b", resolved: `${WT}/b` });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([]);
  });

  test("ignores a symlink that was already there with the same content", async () => {
    const { sandbox, fake } = await preparedWith({
      symlinks: { [`${WT}/tracked`]: OUT },
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.removedLinks).toEqual([]);
  });

  test("restores a symlink that was already there but now has other content", async () => {
    const { fake, sandbox } = await preparedWith({
      symlinks: { [`${WT}/tracked`]: OUT },
    });
    fake.symlinks.set(`${WT}/tracked`, {
      content: "/root/.ssh",
      resolved: "/root/.ssh",
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.symlinks.get(`${WT}/tracked`)?.content).toBe("/etc/passwd");
  });

  test("reports a symlink that was already there but now has other content as a problem", async () => {
    const { fake, sandbox } = await preparedWith({
      symlinks: { [`${WT}/tracked`]: OUT },
    });
    fake.symlinks.set(`${WT}/tracked`, {
      content: "/root/.ssh",
      resolved: "/root/.ssh",
    });
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toEqual([
      `a symlink that existed before the check was changed, so it was restored: ${JSON.stringify(`${WT}/tracked`)}`,
    ]);
  });

  test("does not unlink a symlink that was already there but changed", async () => {
    const { fake, sandbox } = await preparedWith({
      symlinks: { [`${WT}/tracked`]: OUT },
    });
    fake.symlinks.set(`${WT}/tracked`, {
      content: "/root/.ssh",
      resolved: "/root/.ssh",
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.removedLinks).toEqual([]);
  });

  // w/a/b/il -> ../.. はwを指し、w/a/b/x -> il/../outside/new.txt はwの外の新しいファイルを指す。
  test("removes a dangling symlink whose target goes through another symlink and ..", async () => {
    const { fake, sandbox } = await preparedWith({
      realPathOf: (path) => {
        if (path === `${WT}/a/b/il`) return WT;
        if (path.startsWith(`${PARENT}/outside`)) return null;
        return undefined;
      },
    });
    fake.symlinks.set(`${WT}/a/b/x`, {
      content: "il/../outside/new.txt",
      resolved: null,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/a/b/x`,
    ]);
  });

  test("never passes a path with .. to realpath", async () => {
    const asked: string[] = [];
    const { fake, sandbox } = await preparedWith({
      realPathOf: (path) => {
        asked.push(path);
        if (path === `${WT}/a/b/il`) return WT;
        if (path.startsWith(`${PARENT}/outside`)) return null;
        return undefined;
      },
    });
    fake.symlinks.set(`${WT}/a/b/x`, {
      content: "il/../outside/new.txt",
      resolved: null,
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(asked.filter((path) => path.includes(".."))).toEqual([]);
  });

  test("treats a target that leaves the worktree and comes back as outside", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/x`, {
      content: `/tmp/zz/d/../../..${WT}/src`,
      resolved: `${WT}/src`,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([`${WT}/x`]);
  });

  test("keeps an absolute symlink that goes straight down to a path inside", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/x`, {
      content: `${WT}/src`,
      resolved: `${WT}/src`,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([]);
  });

  test("keeps a relative symlink that goes up and comes back into the worktree", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/sub/x`, {
      content: `../../${WT.split("/").at(-1)}/src`,
      resolved: `${WT}/src`,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([]);
  });

  test("treats a remainder with .. as outside because it cannot be resolved", async () => {
    const { fake, sandbox } = await preparedWith({
      realPathOf: (path) => (path.includes("/missing") ? null : undefined),
    });
    fake.symlinks.set(`${WT}/gone`, {
      content: "missing/../ok",
      resolved: null,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/gone`,
    ]);
  });

  test("treats a missing component that is itself a symlink as outside", async () => {
    const { fake, sandbox } = await preparedWith({
      realPathOf: (path) => (path === `${WT}/loop` ? null : undefined),
    });
    fake.symlinks.set(`${WT}/loop`, { content: "/nowhere", resolved: null });
    fake.symlinks.set(`${WT}/via`, { content: "loop/f", resolved: null });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toContain(
      `${WT}/via`,
    );
  });

  test("keeps a dangling symlink inside the worktree", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/sub/new`, {
      content: "later/file.txt",
      resolved: null,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([]);
  });

  test("does not count a sibling directory whose name starts with the worktree name", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/x`, {
      content: `${WT}-other`,
      resolved: `${WT}-other`,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([`${WT}/x`]);
  });

  test("treats a symlink as outside when resolving it fails for another reason", async () => {
    const { fake, sandbox } = await preparedWith({
      realPathFails: `${WT}/sub`,
    });
    fake.symlinks.set(`${WT}/denied`, {
      content: "sub/file",
      resolved: null,
    });
    fake.symlinks.set(`${WT}/other`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/denied`,
      `${WT}/other`,
    ]);
  });

  test("still removes the other symlinks when one cannot be read", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/bad`],
    });
    fake.symlinks.set(`${WT}/bad`, OUT);
    fake.symlinks.set(`${WT}/evil`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/evil`,
    ]);
  });

  test("reports a symlink that cannot be read as a problem", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/bad`],
    });
    fake.symlinks.set(`${WT}/bad`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toContain(
      `could not inspect a symlink, so it was left: ${JSON.stringify(`${WT}/bad`)}`,
    );
  });

  test("reports a symlink that cannot be removed and still removes the others", async () => {
    const { fake, sandbox } = await preparedWith({
      removeFails: `${WT}/stuck`,
    });
    fake.symlinks.set(`${WT}/stuck`, OUT);
    fake.symlinks.set(`${WT}/evil`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/evil`,
    ]);
  });

  test("reports a symlink that cannot be removed as a problem", async () => {
    const { fake, sandbox } = await preparedWith({
      removeFails: `${WT}/stuck`,
    });
    fake.symlinks.set(`${WT}/stuck`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toContain(
      `could not remove or restore ${JSON.stringify(`${WT}/stuck`)}: EPERM`,
    );
  });

  test("reports a cut-short listing as a problem", async () => {
    const { fake, sandbox } = await preparedWith({
      listingTail: "\n[... 99 bytes omitted ...]\n",
    });
    fake.symlinks.set(`${WT}/evil`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toContain(
      "the list of symlinks was cut short, so some symlinks were not checked",
    );
  });

  const SWEEP = sweepLinksArgv(WT);
  const INCOMPLETE =
    "the symlink scan was incomplete, so every symlink whose content is an absolute path or contains .. was removed";

  test("does not sweep when the scan was complete", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/evil`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).not.toContainEqual(SWEEP);
  });

  test("sweeps when a symlink cannot be read", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/bad`],
    });
    fake.symlinks.set(`${WT}/bad`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when the listing was cut short", async () => {
    const { fake, sandbox } = await preparedWith({
      listingTail: "\n[... 99 bytes omitted ...]\n",
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when a name contains U+FFFD", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/a\uFFFD`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when a name with U+FFFD hides an outward symlink behind an inward one", async () => {
    const { fake, sandbox } = await preparedWith({
      symlinks: { [`${WT}/a\uFFFD`]: { content: "ok", resolved: `${WT}/ok` } },
    });
    fake.symlinks.set(`${WT}/a\uFFFD`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when a name contains the omission marker", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/[... 5 bytes omitted ...]`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when a symlink cannot be removed", async () => {
    const { fake, sandbox } = await preparedWith({
      removeFails: `${WT}/stuck`,
    });
    fake.symlinks.set(`${WT}/stuck`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("sweeps when the scan runs out of time", async () => {
    const fake = fakeSandboxDeps();
    let clock = 0;
    const sandbox = sandboxOf({
      ...fake.deps,
      reap: { ...fake.deps.reap, now: () => (clock += 40_000) },
    });
    await sandbox.prepare(DIRS);
    fake.symlinks.set(`${WT}/a`, OUT);
    fake.symlinks.set(`${WT}/b`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(SWEEP);
  });

  test("says the sweep happened", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/bad`],
    });
    fake.symlinks.set(`${WT}/bad`, OUT);
    expect((await sandbox.escapingSymlinks(DIRS)).problems).toContain(
      INCOMPLETE,
    );
  });

  test("throws when the sweep fails, so the work item stops", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/bad`],
      respond: (argv) => (matches(SWEEP)(argv) ? fail("denied", 1) : undefined),
    });
    fake.symlinks.set(`${WT}/bad`, OUT);
    await expect(sandbox.escapingSymlinks(DIRS)).rejects.toThrow("denied");
  });

  test("throws when listing the symlinks fails", async () => {
    const fake = fakeSandboxDeps({ failSymlinkListing: true });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await expect(sandbox.escapingSymlinks(DIRS)).rejects.toThrow(
      "listing symlinks",
    );
  });

  test("treats a target with too many components as outside", async () => {
    const { fake, sandbox } = await preparedWith();
    fake.symlinks.set(`${WT}/deep`, {
      content: Array.from({ length: 1001 }, () => "d").join("/"),
      resolved: null,
    });
    expect((await sandbox.escapingSymlinks(DIRS)).removed).toEqual([
      `${WT}/deep`,
    ]);
  });

  test("escapes a newline in a path so the problems cannot forge lines", async () => {
    const { fake, sandbox } = await preparedWith({
      unreadablePaths: [`${WT}/a\nb`],
    });
    fake.symlinks.set(`${WT}/a\nb`, OUT);
    expect(
      (await sandbox.escapingSymlinks(DIRS)).problems.join("\n"),
    ).not.toContain("a\nb");
  });

  test("keeps the error message out of the problems", async () => {
    const { fake, sandbox } = await preparedWith({
      removeFails: `${WT}/secret-target`,
    });
    fake.symlinks.set(`${WT}/secret-target`, OUT);
    const problems = (await sandbox.escapingSymlinks(DIRS)).problems.join("\n");
    expect(problems).not.toContain("EPERM:");
  });

  test("logs a removed symlink to an unusual place as suspicious", async () => {
    const lines: string[] = [];
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps, {
      log: logger("check_sandbox", { sink: (line) => lines.push(line) }),
    });
    await sandbox.prepare(DIRS);
    fake.symlinks.set(`${WT}/odd`, {
      content: "/root/.ssh/id",
      resolved: "/root/.ssh/id",
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(lines.some((line) => line.includes("suspicious"))).toBe(true);
  });

  test("does not log a removed symlink to a system interpreter as suspicious", async () => {
    const lines: string[] = [];
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps, {
      log: logger("check_sandbox", { sink: (line) => lines.push(line) }),
    });
    await sandbox.prepare(DIRS);
    fake.symlinks.set(`${WT}/py`, {
      content: "/usr/bin/python3",
      resolved: "/usr/bin/python3",
    });
    await sandbox.escapingSymlinks(DIRS);
    expect(lines.some((line) => line.includes("suspicious"))).toBe(false);
  });

  test("logs the removed symlinks", async () => {
    const warnings: string[] = [];
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps, {
      log: logger("check_sandbox", { sink: (line) => warnings.push(line) }),
    });
    await sandbox.prepare(DIRS);
    fake.symlinks.set(`${WT}/evil`, OUT);
    await sandbox.escapingSymlinks(DIRS);
    expect(warnings.some((line) => line.includes(`${WT}/evil`))).toBe(true);
  });
});

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
    const reuid = (argv: readonly string[]) =>
      argv.find((arg) => arg.startsWith("--reuid="));
    expect([reuid(first.wrap(["true"])), reuid(second.wrap(["true"]))]).toEqual(
      ["--reuid=20000", "--reuid=20001"],
    );
  });

  test("caps the processes of the slot's uid before switching to it", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps());
    expect(sandbox.wrap(["bun", "test"]).slice(0, 4)).toEqual([
      PRLIMIT_PATH,
      `--nproc=${String(CHECK_NPROC_LIMIT)}:${String(CHECK_NPROC_LIMIT)}`,
      "--",
      SETPRIV_PATH,
    ]);
  });

  test("prepare fails with CheckImageStaleError on an image without a tool", async () => {
    const fake = fakeSandboxDeps({ missingTools: ["/usr/bin/getfacl"] });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toBeInstanceOf(
      CheckImageStaleError,
    );
  });

  test("prepare fails with CheckImageStaleError on an image without the slot users", async () => {
    const fake = fakeSandboxDeps({
      passwd: "factory-check:x:10001:10001::/:/usr/sbin/nologin\n",
    });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toBeInstanceOf(
      CheckImageStaleError,
    );
  });

  test("prepare fails with CheckRuntimeUnsafeError when the running worker has an open path", async () => {
    const fake = fakeSandboxDeps({ worldWritable: ["/tmp/open"] });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toBeInstanceOf(
      CheckRuntimeUnsafeError,
    );
  });

  test("prepare runs nothing when the running worker has an open path", async () => {
    const fake = fakeSandboxDeps({ worldWritable: ["/tmp/open"] });
    await sandboxOf(fake.deps)
      .prepare(DIRS)
      .catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("prepare on a stale image runs nothing", async () => {
    const fake = fakeSandboxDeps({ missingTools: ["/usr/bin/getfacl"] });
    await sandboxOf(fake.deps)
      .prepare(DIRS)
      .catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("prepare on a stale image takes no slot and writes no record", async () => {
    const fake = fakeSandboxDeps({ missingTools: ["/usr/bin/kill"] });
    await sandboxOf(fake.deps)
      .prepare(DIRS)
      .catch(() => {});
    expect(fake.events).toEqual([]);
  });

  test("checks the image only once for a sandbox", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    await sandbox.release(DIRS);
    const once = fake.imageChecks();
    await sandbox.prepare(DIRS);
    expect(fake.imageChecks()).toBe(once);
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
    expect(argvOf(fake.calls).slice(-4)).toEqual([
      hardLinkedArgv(DIRS.worktreeDir),
      handOverArgv(SLOT0, DIRS.worktreeDir),
      hardLinkedArgv(DIRS.homeDir),
      handOverArgv(SLOT0, DIRS.homeDir),
    ]);
  });

  test("prepare hands the worktree over per directory when a file has a hard link", async () => {
    const fake = fakeSandboxDeps({
      hardLinked: `${DIRS.worktreeDir}/linked\n`,
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(
      chownToArgv(SLOT0, DIRS.worktreeDir),
    );
  });

  test("prepare logs when it falls back to the per-directory handover", async () => {
    const lines: string[] = [];
    const fake = fakeSandboxDeps({
      hardLinked: `${DIRS.worktreeDir}/linked\n`,
    });
    await sandboxOf(fake.deps, {
      log: logger("check_sandbox", { sink: (line) => lines.push(line) }),
    }).prepare(DIRS);
    expect(lines.some((line) => line.includes("per directory"))).toBe(true);
  });

  test("prepare does not hand a worktree with a hard link over in bulk", async () => {
    const fake = fakeSandboxDeps({
      hardLinked: `${DIRS.worktreeDir}/linked\n`,
    });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls)).not.toContainEqual(
      handOverArgv(SLOT0, DIRS.worktreeDir),
    );
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
      fake.events.indexOf(ran(handOverArgv(SLOT0, DIRS.worktreeDir))),
    );
  });

  test("prepare fails when the handover fails", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(handOverArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    await expect(sandboxOf(fake.deps).prepare(DIRS)).rejects.toThrow("denied");
  });

  test("masks a secret in the failure message", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(handOverArgv(SLOT0, DIRS.worktreeDir))(argv)
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
    expect(argvOf(fake.calls).slice(0, TAKE_BACK_LENGTH)).toEqual(
      takeBackSequence(SLOT0, OLD.worktreeDir),
    );
  });

  test("prepare sweeps the symlinks after taking back the worktree a dead run recorded", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls[TAKE_BACK_LENGTH]?.argv).toEqual(
      sweepLinksArgv(OLD.worktreeDir),
    );
  });

  test("release does not sweep the symlinks of a completed run", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))).not.toContainEqual(
      sweepLinksArgv(DIRS.worktreeDir),
    );
  });

  test("prepare removes the home a dead run recorded in the slot", async () => {
    const fake = fakeSandboxDeps({ records: { 0: OLD } });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.calls[TAKE_BACK_LENGTH + 1]?.argv).toEqual(
      removeTreeArgv(OLD.homeDir),
    );
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
    await sandboxOf(fake.deps, { onNotice: fake.onNotice }).prepare(DIRS);
    expect(fake.notices.map((notice) => notice.kind)).toEqual([
      "check_slot_skipped",
    ]);
  });

  test("prepare names the skipped slot in its notice", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    await sandboxOf(fake.deps, { onNotice: fake.onNotice }).prepare(DIRS);
    expect(fake.notices[0]?.message).toContain("factory-check-0(uid 20000)");
  });

  test("prepare goes on with the next slot when the notice cannot be recorded", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    const sandbox = sandboxOf(fake.deps, {
      onNotice: async () => {
        throw new Error("db down");
      },
      log: logger("check_sandbox", { sink: () => {} }),
    });
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20001");
  });

  test("prepare logs a notice it could not record", async () => {
    const fake = fakeSandboxDeps({ stuck: { 50: 20000 } });
    const lines: string[] = [];
    await sandboxOf(fake.deps, {
      onNotice: async () => {
        throw new Error("db down");
      },
      log: logger("check_sandbox", { sink: (line) => lines.push(line) }),
    }).prepare(DIRS);
    expect(lines.join("\n")).toContain("db down");
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

  test("prepare sets aside a record that cannot be read", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events).toContain("record-set-aside 0");
  });

  test("prepare keeps using a slot whose unreadable record it set aside", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS);
    expect(sandbox.wrap(["true"])).toContain("--reuid=20000");
  });

  test("prepare still clears the shared directories of a slot whose record it set aside", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(purgeDirsArgv(20000, "/tmp"));
  });

  test("prepare reports a record it set aside", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    await sandboxOf(fake.deps, { onNotice: fake.onNotice }).prepare(DIRS);
    expect(fake.notices.map((notice) => notice.kind)).toEqual([
      "check_slot_record_unreadable",
    ]);
  });

  test("prepare names the moved record in its notice", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    await sandboxOf(fake.deps, { onNotice: fake.onNotice }).prepare(DIRS);
    expect(fake.notices[0]?.message).toContain("slot-0.state.corrupt-1");
  });

  test("prepare refuses a home that a record cannot hold", async () => {
    const fake = fakeSandboxDeps();
    await expect(
      sandboxOf(fake.deps).prepare({ ...DIRS, homeDir: "/tmp" }),
    ).rejects.toThrow("cannot be recorded");
  });

  test("prepare takes no slot for a worktree that a record cannot hold", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps)
      .prepare({ ...DIRS, worktreeDir: "/workspaces/acme/../wt" })
      .catch(() => {});
    expect(fake.events.filter((event) => event.startsWith("acquire"))).toEqual(
      [],
    );
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
        matches(handOverArgv(SLOT0, DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.events).toContain("release-slot 0");
  });

  test("release after the symlink scan failed in prepare gives the slot back", async () => {
    const fake = fakeSandboxDeps({ failSymlinkListing: true });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.events).toContain("release-slot 0");
  });

  test("release after the symlink scan failed in prepare takes the worktree back", async () => {
    const fake = fakeSandboxDeps({ failSymlinkListing: true });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls)).toContainEqual(
      gatherArgv(SLOT0, DIRS.worktreeDir),
    );
  });

  test("prepare records the worktree before it scans for symlinks", async () => {
    const fake = fakeSandboxDeps();
    await sandboxOf(fake.deps).prepare(DIRS);
    expect(fake.events.indexOf("record-write 0")).toBeLessThan(
      fake.events.indexOf(ran(symlinksArgv(DIRS.worktreeDir))),
    );
  });

  test("release after a failed prepare takes the worktree back", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(handOverArgv(SLOT0, DIRS.worktreeDir))(argv)
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

  test("settle passes when no process of the slot uid is left", async () => {
    const { sandbox } = await prepared(fakeSandboxDeps());
    await expect(sandbox.settle()).resolves.toBeUndefined();
  });

  test("settle stops every process of the slot uid, whatever its groups", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    // 準備の後に、補助グループを持たない枠のuidのプロセスが残っている。
    Object.assign(fake.deps.reap, {
      listPids: async () => (fake.killed.includes(60) ? [] : [60]),
      readStatus: async () => status({ uid: 20000, groups: [] }),
      killAll: async () => {
        fake.killed.push(60);
      },
    });
    await sandbox.settle();
    expect(fake.killed).toEqual([60]);
  });

  test("settle fails when a process of the slot uid cannot be stopped", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_PROCESS);
    await expect(sandbox.settle()).rejects.toThrow("could not be stopped");
  });

  test("release takes the worktree back and then removes the home", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(
      argvOf(fake.calls.slice(before)).slice(0, TAKE_BACK_LENGTH + 1),
    ).toEqual([
      ...takeBackSequence(SLOT0, DIRS.worktreeDir),
      removeTreeArgv(DIRS.homeDir),
    ]);
  });

  test.each([...SHARED_TMP_DIRS])(
    "release removes the slot uid's files in %s",
    async (dir) => {
      const fake = fakeSandboxDeps();
      const { sandbox, before } = await prepared(fake);
      await sandbox.release(DIRS);
      expect(argvOf(fake.calls.slice(before))).toContainEqual(
        purgeFilesArgv(20000, dir),
      );
    },
  );

  test("release purges the shared directories after removing the home", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))[TAKE_BACK_LENGTH + 1]).toEqual(
      purgeDirsArgv(20000, "/tmp"),
    );
  });

  test("release purges the shared directories before clearing the record", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS);
    expect(
      fake.events.lastIndexOf(ran(remainingOfUidArgv(20000, "/dev/mqueue"))),
    ).toBeLessThan(fake.events.lastIndexOf("record-clear 0"));
  });

  test("release removes the IPC objects the check left", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox, before } = await prepared(fake);
    Object.assign(fake.deps, {
      listIpc: async () => [{ kind: "shm", id: 9, uid: 20000, cuid: 20000 }],
    });
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))).toContainEqual(
      setprivArgv(SLOT0, ["/usr/bin/ipcrm", "-m", "9"]),
    );
  });

  test("release still clears the record when shared files remain", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps, {
      run: async (argv: readonly string[]) =>
        matches(remainingOfUidArgv(20000, "/tmp"))(argv)
          ? ok("/tmp/left\n")
          : ok(),
    });
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.records.has(0)).toBe(false);
  });

  test("release logs the shared files it could not remove", async () => {
    const fake = fakeSandboxDeps();
    const lines: string[] = [];
    const sandbox = sandboxOf(fake.deps, {
      log: logger("check_sandbox", { sink: (line) => lines.push(line) }),
    });
    await sandbox.prepare(DIRS);
    Object.assign(fake.deps, {
      run: async (argv: readonly string[]) =>
        matches(remainingOfUidArgv(20000, "/tmp"))(argv)
          ? ok("/tmp/left\n")
          : ok(),
    });
    await sandbox.release(DIRS);
    expect(lines.join("\n")).toContain("/tmp/left");
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

  test("release keeps the record until the symlink scan is done", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(fake.records.has(0)).toBe(true);
  });

  test("the symlink scan clears the record after the slot is given back", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.events.indexOf("release-slot 0")).toBeLessThan(
      fake.events.indexOf("record-clear 0"),
    );
  });

  test("the symlink scan clears the record", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.records.has(0)).toBe(false);
  });

  test("the record stays when the symlink scan throws", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    Object.assign(fake.deps, {
      run: async (argv: readonly string[]) =>
        matches(symlinksArgv(DIRS.worktreeDir))(argv)
          ? fail("find failed", 1)
          : ok(),
    });
    await sandbox.escapingSymlinks(DIRS).catch(() => {});
    expect(fake.records.has(0)).toBe(true);
  });

  test("the record stays when the sweep fails", async () => {
    const fake = fakeSandboxDeps({
      unreadablePaths: [`${DIRS.worktreeDir}/bad`],
      respond: (argv) =>
        matches(sweepLinksArgv(DIRS.worktreeDir))(argv)
          ? fail("denied", 1)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    fake.symlinks.set(`${DIRS.worktreeDir}/bad`, {
      content: "/etc/passwd",
      resolved: "/etc/passwd",
    });
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS).catch(() => {});
    expect(fake.records.has(0)).toBe(true);
  });

  test("the scan does not clear a record that points to another worktree", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    fake.records.set(0, OLD);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.records.get(0)).toEqual(OLD);
  });

  test("a recovery sweeps the symlinks of a run that was cancelled before its scan", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    const next = sandboxOf(fake.deps);
    await next.prepare({
      worktreeDir: "/workspaces/acme/other/wt-2",
      homeDir: "/tmp/factory-check-home-next",
    });
    expect(argvOf(fake.calls)).toContainEqual(sweepLinksArgv(DIRS.worktreeDir));
  });

  test("release clears the record of a run whose prepare failed before the scan", async () => {
    const fake = fakeSandboxDeps({ failSymlinkListing: true });
    const sandbox = sandboxOf(fake.deps);
    await sandbox.prepare(DIRS).catch(() => {});
    await sandbox.release(DIRS);
    expect(fake.records.has(0)).toBe(false);
  });

  test("release removes no ACL when none is found", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls)).not.toContainEqual(
      removeAclArgv(DIRS.worktreeDir),
    );
  });

  test("release removes the ACLs it finds once the worktree is back with root", async () => {
    const fake = fakeSandboxDeps({ respond: aclFoundOnce(DIRS.worktreeDir) });
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(
      argvOf(fake.calls.slice(before)).slice(0, TAKE_BACK_LENGTH + 4),
    ).toEqual([
      ...takeBackSequence(SLOT0, DIRS.worktreeDir),
      removeAclArgv(DIRS.worktreeDir),
      leftoverArgv(DIRS.worktreeDir),
      aclLeftoverArgv(DIRS.worktreeDir),
      removeTreeArgv(DIRS.homeDir),
    ]);
  });

  test("release clears the record once the ACLs it found are gone", async () => {
    const fake = fakeSandboxDeps({ respond: aclFoundOnce(DIRS.worktreeDir) });
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS);
    await sandbox.escapingSymlinks(DIRS);
    expect(fake.records.has(0)).toBe(false);
  });

  test("release fails when ACLs remain after removing them", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(aclLeftoverArgv(DIRS.worktreeDir))(argv)
          ? ok(`# file: ${DIRS.worktreeDir}/shared\n`)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await expect(sandbox.release(DIRS)).rejects.toThrow("ACL");
  });

  test("release keeps the record when ACLs remain", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(aclLeftoverArgv(DIRS.worktreeDir))(argv)
          ? ok(`# file: ${DIRS.worktreeDir}/shared\n`)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("release does not remove ACLs while entries of others remain", async () => {
    const fake = fakeSandboxDeps({
      respond: (argv) =>
        matches(leftoverArgv(DIRS.worktreeDir))(argv)
          ? ok(`${DIRS.worktreeDir}/x\n`)
          : undefined,
    });
    const { sandbox } = await prepared(fake);
    await sandbox.release(DIRS).catch(() => {});
    expect(argvOf(fake.calls)).not.toContainEqual(
      removeAclArgv(DIRS.worktreeDir),
    );
  });

  test("release does not take back a worktree that is gone", async () => {
    const fake = fakeSandboxDeps({
      pathKinds: { [DIRS.worktreeDir]: "missing" },
    });
    const { sandbox, before } = await prepared(fake);
    await sandbox.release(DIRS);
    expect(argvOf(fake.calls.slice(before))[0]).toEqual(
      removeTreeArgv(DIRS.homeDir),
    );
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
    Object.assign(fake.deps.reap, STUCK_PROCESS);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.calls.length).toBe(before);
  });

  test("release keeps the record while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_PROCESS);
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.records.get(0)).toEqual(DIRS);
  });

  test("release fails loudly while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_PROCESS);
    await expect(sandbox.release(DIRS)).rejects.toThrow("could not be stopped");
  });

  test("release still gives the slot back while a process survives", async () => {
    const fake = fakeSandboxDeps();
    const { sandbox } = await prepared(fake);
    Object.assign(fake.deps.reap, STUCK_PROCESS);
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
    expect(withoutTag(argvOf(fake.calls).slice(0, TAKE_BACK_LENGTH))).toEqual(
      withoutTag(takeBackSequence(SLOT1, WT)),
    );
  });

  test("sweeps the symlinks after taking the recorded worktree back", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(argvOf(fake.calls)[TAKE_BACK_LENGTH]).toEqual(sweepLinksArgv(WT));
  });

  test("fails and keeps the record when the sweep fails", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(sweepLinksArgv(WT))(argv) ? fail("denied", 1) : undefined,
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.records.has(1)).toBe(true);
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

  test("fails with CheckSlotInUseError when another run holds the slot", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, busySlots: [1] });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps, 100),
    ).rejects.toBeInstanceOf(CheckSlotInUseError);
  });

  test("runs nothing when another run holds the slot", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, busySlots: [1] });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100).catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("does not stop processes when another run holds the slot", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      busySlots: [1],
      processes: { 90: status({ uid: 20001, groups: [] }) },
    });
    await restoreCheckOwnership(WT, POOL, fake.deps, 100).catch(() => {});
    expect(fake.killed).toEqual([]);
  });

  test("ignores a held slot whose record names another worktree", async () => {
    const fake = fakeSandboxDeps({
      records: { 0: OLD, 1: DIRS },
      busySlots: [0],
    });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps, 100)).toBe(true);
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

  test("goes on when an unreadable record remains but root owns the whole worktree", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    expect(await restoreCheckOwnership(WT, POOL, fake.deps)).toBe(false);
  });

  test("looks for entries root does not own when a record cannot be read", async () => {
    const fake = fakeSandboxDeps({ corruptRecords: [0] });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(argvOf(fake.calls)).toEqual([notRootOwnedArgv(WT)]);
  });

  test("fails with CheckOwnershipRestoreError when an unreadable record remains and others own entries", async () => {
    const fake = fakeSandboxDeps({
      corruptRecords: [0],
      respond: (argv) =>
        matches(notRootOwnedArgv(WT))(argv) ? ok(`${WT}/x\n`) : undefined,
    });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps),
    ).rejects.toBeInstanceOf(CheckOwnershipRestoreError);
  });

  test("names the path of the unreadable record in the failure", async () => {
    const fake = fakeSandboxDeps({
      corruptRecords: [0],
      respond: (argv) =>
        matches(notRootOwnedArgv(WT))(argv) ? ok(`${WT}/x\n`) : undefined,
    });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      "/var/lib/factory/check-slots/slot-0.state",
    );
  });

  test("names the entry others own in the failure", async () => {
    const fake = fakeSandboxDeps({
      corruptRecords: [0],
      respond: (argv) =>
        matches(notRootOwnedArgv(WT))(argv) ? ok(`${WT}/x\n`) : undefined,
    });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      `${WT}/x`,
    );
  });

  test("passes through an error reading a record other than an unreadable one", async () => {
    const fake = fakeSandboxDeps({ failingRecordReads: [0] });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      "EIO",
    );
  });

  test("goes on when the run holding the slot cleared the record while it waited", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, busySlots: [1] });
    let reads = 0;
    const deps: CheckSandboxDeps = {
      ...fake.deps,
      slotRecords: {
        ...fake.deps.slotRecords,
        read: async (index) => {
          if (index !== 1) return null;
          reads += 1;
          return reads === 1 ? DIRS : null;
        },
      },
    };
    expect(await restoreCheckOwnership(WT, POOL, deps, 100)).toBe(false);
  });

  test("fails with CheckOwnershipRestoreError when taking the worktree back fails", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(gatherArgv(SLOT1, WT))(argv) ? fail("denied", 1) : undefined,
    });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps),
    ).rejects.toBeInstanceOf(CheckOwnershipRestoreError);
  });

  test("names the slot whose worktree could not be taken back", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      respond: (argv) =>
        matches(gatherArgv(SLOT1, WT))(argv) ? fail("denied", 1) : undefined,
    });
    await expect(restoreCheckOwnership(WT, POOL, fake.deps)).rejects.toThrow(
      "factory-check-1",
    );
  });

  test("fails with CheckOwnershipRestoreError when a process of the slot cannot be stopped", async () => {
    const fake = fakeSandboxDeps({ records: RECORDED, stuck: { 50: 20001 } });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps),
    ).rejects.toBeInstanceOf(CheckOwnershipRestoreError);
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

  test("fails with CheckImageStaleError on an image that cannot take the worktree back", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      missingTools: ["/usr/bin/getfacl"],
    });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps),
    ).rejects.toBeInstanceOf(CheckImageStaleError);
  });

  test("fails with CheckRuntimeUnsafeError when the running worker has an open path", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      worldWritable: ["/tmp/open"],
    });
    await expect(
      restoreCheckOwnership(WT, POOL, fake.deps),
    ).rejects.toBeInstanceOf(CheckRuntimeUnsafeError);
  });

  test("runs nothing on a stale image", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      missingTools: ["/usr/bin/getfacl"],
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("does not take the slot on a stale image", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      missingTools: ["/usr/bin/getfacl"],
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.events.filter((event) => event.startsWith("acquire"))).toEqual(
      [],
    );
  });

  test("keeps the record on a stale image", async () => {
    const fake = fakeSandboxDeps({
      records: RECORDED,
      missingTools: ["/usr/bin/getfacl"],
    });
    await restoreCheckOwnership(WT, POOL, fake.deps).catch(() => {});
    expect(fake.records.get(1)).toEqual(DIRS);
  });

  test("does not look at the image when no record names the worktree", async () => {
    const fake = fakeSandboxDeps({
      records: { 0: OLD },
      missingTools: ["/usr/bin/getfacl"],
    });
    await restoreCheckOwnership(WT, POOL, fake.deps);
    expect(fake.imageChecks()).toBe(0);
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
