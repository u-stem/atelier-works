import { describe, expect, test } from "bun:test";
import {
  CHECK_ENV_KEYS,
  type CheckDirs,
  type CheckIdentity,
  type CheckSandboxDeps,
  checkEnv,
  chownBackArgv,
  chownToArgv,
  createCheckSandbox,
  DEFAULT_CHECK_UID,
  isTaggedProcess,
  newCheckIdentity,
  parseCheckUid,
  parsePasswdUid,
  parseProcStatus,
  type ReapDeps,
  reapCheckProcesses,
  resolveCheckUid,
  SETPRIV_PATH,
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

describe("parsePasswdUid", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "factory-check:x:10001:10001::/home/factory-check:/usr/sbin/nologin",
    "other:x:1000:1000::/home/other:/bin/sh",
  ].join("\n");

  test("reads the uid of the named user", () => {
    expect(parsePasswdUid(passwd, "factory-check")).toBe(10001);
  });

  test("returns null when the user is missing", () => {
    expect(parsePasswdUid(passwd, "nobody")).toBeNull();
  });

  test("does not match a user whose name only starts with the given name", () => {
    expect(
      parsePasswdUid("factory-check2:x:555:555::/:/bin/sh", "factory-check"),
    ).toBeNull();
  });

  test("returns null when the uid field is not a number", () => {
    expect(
      parsePasswdUid("factory-check:x:abc:1::/:/bin/sh", "factory-check"),
    ).toBeNull();
  });

  test("returns null for an empty file", () => {
    expect(parsePasswdUid("", "factory-check")).toBeNull();
  });
});

describe("resolveCheckUid", () => {
  const passwd = () => "factory-check:x:20000:20000::/:/usr/sbin/nologin\n";

  test("prefers the environment variable", () => {
    expect(resolveCheckUid({ FACTORY_CHECK_UID: "30000" }, passwd)).toBe(30000);
  });

  test("rejects an invalid environment variable even when the passwd entry is fine", () => {
    expect(() => resolveCheckUid({ FACTORY_CHECK_UID: "0" }, passwd)).toThrow();
  });

  test("reads the uid of the factory-check user when the variable is unset", () => {
    expect(resolveCheckUid({}, passwd)).toBe(20000);
  });

  test("falls back to the default when passwd cannot be read", () => {
    expect(
      resolveCheckUid({}, () => {
        throw new Error("ENOENT");
      }),
    ).toBe(DEFAULT_CHECK_UID);
  });

  test("falls back to the default when passwd has no factory-check user", () => {
    expect(resolveCheckUid({}, () => "root:x:0:0::/root:/bin/sh\n")).toBe(
      DEFAULT_CHECK_UID,
    );
  });

  test("rejects a passwd entry that maps factory-check to root", () => {
    expect(() =>
      resolveCheckUid({}, () => "factory-check:x:0:0::/:/bin/sh\n"),
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

  test("also uses find -P and chown -h when taking back", () => {
    expect([back[1], back.includes("-h")]).toEqual(["-P", true]);
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

/** 呼び出しの順序を記録する、`createCheckSandbox`用の偽の依存。 */
function fakeSandboxDeps(opts?: {
  readonly runResponses?: readonly Parameters<
    typeof createFakeCommandRunner
  >[0][number][];
  readonly leftover?: readonly number[];
}) {
  const events: string[] = [];
  const runner = createFakeCommandRunner(opts?.runResponses ?? [ok(), ok()]);
  const deps: CheckSandboxDeps = {
    run: async (argv, options) => {
      events.push(`run ${argv[0]?.split("/").pop() ?? ""} ${argv[2] ?? ""}`);
      return runner.run(argv, options);
    },
    reap: {
      listPids: async () => {
        events.push("list");
        return [...(opts?.leftover ?? [])];
      },
      readStatus: async () => status({ groups: [1_000_000] }),
      kill: () => {},
      sleep: async () => {},
    },
    lockDownRuntimeDir: async (dir) => {
      events.push(`lockdown ${dir}`);
    },
    assertDirectory: async (path) => {
      events.push(`assertDirectory ${path}`);
    },
  };
  return { deps, events, calls: runner.calls };
}

describe("createCheckSandbox", () => {
  test("exposes the identity it was built with", () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 20000,
      deps: fake.deps,
      random: () => 0.5,
    });
    expect(sandbox.identity.uid).toBe(20000);
  });

  test("wraps a command with setpriv for its identity", () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    expect(sandbox.wrap(["bun", "test"]).slice(-3)).toEqual([
      "--",
      "bun",
      "test",
    ]);
  });

  test("prepare locks down the runtime directory before handing anything over", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.prepare(DIRS);
    expect(fake.events[0]).toBe(`lockdown ${WINDMILL_TMP_DIR}`);
  });

  test("prepare checks that the worktree is a real directory", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.prepare(DIRS);
    expect(fake.events).toContain(`assertDirectory ${DIRS.worktreeDir}`);
  });

  test("prepare hands the worktree and the home over to the check uid", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.prepare(DIRS);
    expect(fake.calls.map((call) => call.argv[2])).toEqual([
      DIRS.worktreeDir,
      DIRS.homeDir,
    ]);
  });

  test("prepare fails when the handover fails", async () => {
    const fake = fakeSandboxDeps({ runResponses: [fail("denied", 1)] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await expect(sandbox.prepare(DIRS)).rejects.toThrow("denied");
  });

  test("prepare stops before handing over when the runtime directory cannot be locked down", async () => {
    const fake = fakeSandboxDeps();
    const deps: CheckSandboxDeps = {
      ...fake.deps,
      lockDownRuntimeDir: async () => {
        throw new Error("chmod failed");
      },
    };
    const sandbox = createCheckSandbox({ uid: 10001, deps, random: () => 0 });
    await expect(sandbox.prepare(DIRS)).rejects.toThrow("chmod failed");
    expect(fake.calls).toEqual([]);
  });

  test("settle passes when no tagged process is left", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await expect(sandbox.settle()).resolves.toBeUndefined();
  });

  test("settle fails when a tagged process cannot be stopped", async () => {
    const fake = fakeSandboxDeps({ leftover: [50] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await expect(sandbox.settle()).rejects.toThrow("could not be stopped");
  });

  test("release stops stray processes before taking ownership back", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.release(DIRS);
    expect(fake.events[0]).toBe("list");
  });

  test("release takes the worktree back from the check uid", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.release(DIRS);
    expect(fake.calls[0]?.argv).toContain("--from=10001");
  });

  test("release does not take ownership back while a process survives", async () => {
    const fake = fakeSandboxDeps({ leftover: [50] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.release(DIRS).catch(() => {});
    expect(fake.calls).toEqual([]);
  });

  test("release fails loudly while a process survives", async () => {
    const fake = fakeSandboxDeps({ leftover: [50] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await expect(sandbox.release(DIRS)).rejects.toThrow("could not be stopped");
  });

  test("release fails when taking ownership back fails", async () => {
    const fake = fakeSandboxDeps({ runResponses: [fail("busy", 1)] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await expect(sandbox.release(DIRS)).rejects.toThrow("busy");
  });

  test("release takes both the worktree and the home back", async () => {
    const fake = fakeSandboxDeps();
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    await sandbox.release(DIRS);
    expect(fake.calls.map((call) => call.argv[2])).toEqual([
      DIRS.worktreeDir,
      DIRS.homeDir,
    ]);
  });

  test("masks a secret in the failure message", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const fake = fakeSandboxDeps({ runResponses: [fail(`leaked ${secret}`)] });
    const sandbox = createCheckSandbox({
      uid: 10001,
      deps: fake.deps,
      random: () => 0,
    });
    const message = await sandbox.prepare(DIRS).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(message).not.toContain(secret);
  });
});
