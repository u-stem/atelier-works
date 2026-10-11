import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runAllowedCheckCommands } from "../../f/factory/lib/check_runner.ts";
import {
  CHECK_ENV_KEYS,
  type CheckSandbox,
  createCheckSandbox,
  defaultSandboxDeps,
  parsePasswdUsers,
  resolveCheckPool,
  restoreCheckOwnership,
  WINDMILL_TMP_DIR,
} from "../../f/factory/lib/check_sandbox.ts";
import {
  FLOCK_PATH,
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../../f/factory/lib/process_lock.ts";
import { runCommand } from "../../f/factory/lib/workspace.ts";

// workerのイメージの中で、実際のsetpriv・flock・chown・/procを使って、検査コマンドの境界を確かめる。
// 検査用のuidで動く検査コマンドが、workerの秘密に届かず、書き込める場所が限られ、
// 検査の後にworktreeがrootに戻り、残ったプロセスが無いことを見る。
// `/tmp/windmill`の権限を書き換えるので、`scripts/verify-check-sandbox.sh`が使い捨てのコンテナで
// `FACTORY_CHECK_SANDBOX_IT=1`を付けて走らせるときだけ動く。それ以外では飛ばす。
const SETPRIV = "/usr/bin/setpriv";
const enabled =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  process.env.FACTORY_CHECK_SANDBOX_IT === "1" &&
  existsSync(SETPRIV) &&
  existsSync(FLOCK_PATH);
const suite = enabled ? describe : describe.skip;

const readPasswd = (): string => readFileSync("/etc/passwd", "utf8");
const POOL = resolveCheckPool(process.env, readPasswd);

/** 検査の子孫として残したプロセスを探すため、実uidが`uids`のどれかである生きたプロセスのpidを返す。 */
function processesOf(uids: readonly number[]): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
        const state = /^State:\s+(\S)/m.exec(status)?.[1];
        return uids.includes(uid) && state !== "Z";
      } catch {
        return false;
      }
    })
    .map((name) => Number(name));
}

function runSync(argv: string[], cwd: string): number {
  const proc = Bun.spawnSync({
    cmd: argv,
    cwd,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return proc.exitCode;
}

/** `key=value`の行を並べた出力を、キーごとの値にする。値に`=`が入ってもよい。 */
function parseProbeOutput(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1));
  }
  return values;
}

/** 準備のコマンドを実行し、失敗したら例外を投げる。 */
function mustRun(argv: string[], cwd: string): void {
  const code = runSync(argv, cwd);
  if (code !== 0)
    throw new Error(`${argv.join(" ")} exited with ${String(code)}`);
}

suite("check commands in the worker image", () => {
  const base = mkdtempSync("/tmp/check-sandbox-it-");
  const repo = join(base, "repo");
  const worktree = join(base, "wt");
  const secretFile = join(base, "worker-token");
  const hardlink = join(worktree, "hardlink-to-secret");
  const symlinkToSecret = join(worktree, "symlink-to-secret");
  const symlinkToDir = join(worktree, "symlink-to-dir");
  const outside = join(base, "outside");
  const outsideFile = join(outside, "file");
  const sibling = join(base, "sibling-secret-dir");
  const slotLockDir = join(base, "slots");
  let rootSecretProcess: ReturnType<typeof Bun.spawn> | undefined;
  let values = new Map<string, string>();
  let home = "";

  /** 検査の中で実行するスクリプト。1行に`key=value`を出し、テストが読む。 */
  function probeScript(rootPid: number): string {
    return `
printf 'uid=%s\\n' "$(id -u)"
printf 'gid=%s\\n' "$(id -g)"
printf 'caps_eff=%s\\n' "$(awk '/^CapEff:/{print $2}' /proc/self/status)"
printf 'caps_bnd=%s\\n' "$(awk '/^CapBnd:/{print $2}' /proc/self/status)"
printf 'no_new_privs=%s\\n' "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)"
printf 'home=%s\\n' "$HOME"
printf 'env_keys=%s\\n' "$(env | cut -d= -f1 | sort | tr '\\n' ' ')"
printf 'read_pid1_environ=%s\\n' "$(cat /proc/1/environ >/dev/null 2>&1 && echo readable || echo denied)"
printf 'read_root_process_environ=%s\\n' "$(cat /proc/${rootPid}/environ >/dev/null 2>&1 && echo readable || echo denied)"
printf 'read_secret_file=%s\\n' "$(cat ${secretFile} >/dev/null 2>&1 && echo readable || echo denied)"
printf 'write_worktree=%s\\n' "$(touch ./made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'write_home=%s\\n' "$(touch "$HOME/made-by-check" 2>/dev/null && echo ok || echo denied)"
printf 'write_tmp=%s\\n' "$(touch /tmp/made-by-check-$$ 2>/dev/null && rm -f /tmp/made-by-check-$$ && echo ok || echo denied)"
printf 'write_windmill_cache=%s\\n' "$(touch ${WINDMILL_TMP_DIR}/cache/made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'write_main_clone_git=%s\\n' "$(touch ${repo}/.git/config.made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'write_main_clone_hooks=%s\\n' "$(touch ${repo}/.git/hooks/made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'write_sibling_dir=%s\\n' "$(touch ${sibling}/made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'write_usr_bin=%s\\n' "$(touch /usr/local/bin/made-by-check 2>/dev/null && echo ok || echo denied)"
printf 'hardlink_owner=%s\\n' "$(stat -c %u ./hardlink-to-secret)"
printf 'symlink_target_owner=%s\\n' "$(stat -L -c %u ./symlink-to-secret)"
printf 'outside_owner=%s\\n' "$(stat -c %u ${outsideFile})"
printf 'read_slot_locks=%s\\n' "$(ls ${slotLockDir} >/dev/null 2>&1 && echo readable || echo denied)"
printf 'git_status=%s\\n' "$(git status --porcelain >/dev/null 2>&1 && echo ok || echo failed)"
printf 'git_head=%s\\n' "$(git rev-parse --verify HEAD 2>/dev/null)"
printf 'gain_privilege=%s\\n' "$(${SETPRIV} --reuid=0 -- id -u 2>/dev/null || echo denied)"
setsid sleep 300 >/dev/null 2>&1 &
sleep 0.2
`;
  }

  beforeAll(async () => {
    chmodSync(base, 0o755);
    mkdirSync(repo);
    mustRun(["git", "init", "-q", "."], repo);
    mustRun(
      [
        "git",
        "-c",
        "user.name=it",
        "-c",
        "user.email=it@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      repo,
    );
    mustRun(["git", "worktree", "add", "-q", worktree, "-b", "wt"], repo);
    writeFileSync(secretFile, "worker-token-value\n", { mode: 0o600 });
    mkdirSync(outside);
    writeFileSync(outsideFile, "x\n");
    mkdirSync(sibling);
    // Windmillが作るのと同じ、誰でも書き込める実行時のディレクトリ。
    mkdirSync(join(WINDMILL_TMP_DIR, "cache"), { recursive: true });
    chmodSync(WINDMILL_TMP_DIR, 0o777);
    chmodSync(join(WINDMILL_TMP_DIR, "cache"), 0o777);
    linkSync(secretFile, hardlink);
    symlinkSync(secretFile, symlinkToSecret);
    symlinkSync(outside, symlinkToDir);
    // workerの秘密を環境変数に持つrootのプロセス。
    rootSecretProcess = Bun.spawn(["sleep", "300"], {
      env: { WM_TOKEN: "worker-secret-value", PATH: "/usr/bin:/bin" },
    });
    writeFileSync(
      join(worktree, "probe.sh"),
      probeScript(rootSecretProcess.pid),
    );

    const sandbox = createCheckSandbox({
      uids: POOL,
      deps: defaultSandboxDeps(slotLockDir),
    });
    const lockedRun = withWorktreeProcessLock(
      runCommand,
      worktreeLockFor(worktree),
      { kind: "implement", workItemId: 1, jobId: "it" },
    );
    const before = process.env.WM_TOKEN;
    process.env.WM_TOKEN = "this-process-secret";
    try {
      const [result] = await runAllowedCheckCommands(
        lockedRun,
        worktree,
        ["sh ./probe.sh"],
        30_000,
        undefined,
        undefined,
        sandbox,
      );
      values = parseProbeOutput(result?.output ?? "");
      home = values.get("home") ?? "";
    } finally {
      if (before === undefined) delete process.env.WM_TOKEN;
      else process.env.WM_TOKEN = before;
    }
  });

  afterAll(() => {
    rootSecretProcess?.kill();
    rmSync(base, { recursive: true, force: true });
  });

  const probed = (key: string): string => values.get(key) ?? "<missing>";

  test("the command runs as a uid of the pool", () => {
    expect(POOL.includes(Number(probed("uid")))).toBe(true);
  });

  test("the command's primary gid is its uid", () => {
    expect(probed("gid")).toBe(probed("uid"));
  });

  test("the command has no effective capability", () => {
    expect(probed("caps_eff")).toBe("0000000000000000");
  });

  test("the command's capability bounding set is empty", () => {
    expect(probed("caps_bnd")).toBe("0000000000000000");
  });

  test("the command runs with no_new_privs", () => {
    expect(probed("no_new_privs")).toBe("1");
  });

  test("the command cannot switch back to root", () => {
    expect(probed("gain_privilege")).toBe("denied");
  });

  test("the command's environment holds only allow-listed keys", () => {
    const allowed = new Set<string>([
      ...CHECK_ENV_KEYS,
      "FACTORY_LOCK_OWNER",
      "FACTORY_LOCK_PATH",
      "PWD",
      "SHLVL",
      "_",
      "OLDPWD",
    ]);
    const extra = probed("env_keys")
      .split(" ")
      .filter((key) => key !== "" && !allowed.has(key));
    expect(extra).toEqual([]);
  });

  test("the command does not receive the runner's own WM_TOKEN", () => {
    expect(probed("env_keys").split(" ")).not.toContain("WM_TOKEN");
  });

  test("the command cannot read PID 1's environment", () => {
    expect(probed("read_pid1_environ")).toBe("denied");
  });

  test("the command cannot read the environment of a root process holding a secret", () => {
    expect(probed("read_root_process_environ")).toBe("denied");
  });

  test("the command cannot read a root-only token file", () => {
    expect(probed("read_secret_file")).toBe("denied");
  });

  test("the command can write inside the worktree", () => {
    expect(probed("write_worktree")).toBe("ok");
  });

  test("the command can write inside its home", () => {
    expect(probed("write_home")).toBe("ok");
  });

  test("the command can write to /tmp", () => {
    expect(probed("write_tmp")).toBe("ok");
  });

  test("the command cannot write to the Windmill cache", () => {
    expect(probed("write_windmill_cache")).toBe("denied");
  });

  test("the command cannot write to the main clone's git directory", () => {
    expect(probed("write_main_clone_git")).toBe("denied");
  });

  test("the command cannot write to the main clone's hooks", () => {
    expect(probed("write_main_clone_hooks")).toBe("denied");
  });

  test("the command cannot write next to the worktree", () => {
    expect(probed("write_sibling_dir")).toBe("denied");
  });

  test("the command cannot write to a system directory", () => {
    expect(probed("write_usr_bin")).toBe("denied");
  });

  test("a hard-linked file stays owned by root during the check", () => {
    expect(probed("hardlink_owner")).toBe("0");
  });

  test("a symlink's target stays owned by root during the check", () => {
    expect(probed("symlink_target_owner")).toBe("0");
  });

  test("a file behind a symlinked directory stays owned by root during the check", () => {
    expect(probed("outside_owner")).toBe("0");
  });

  test("git works in the worktree during the check", () => {
    expect(probed("git_status")).toBe("ok");
  });

  test("git reads the worktree's HEAD during the check", () => {
    expect(probed("git_head")).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a file the check created is owned by root afterwards", () => {
    expect(statSync(join(worktree, "made-by-check")).uid).toBe(0);
  });

  test("the worktree directory is owned by root afterwards", () => {
    expect(lstatSync(worktree).uid).toBe(0);
  });

  test("the files the check owned are no longer owned by the check uid", () => {
    expect(statSync(join(worktree, "probe.sh")).uid).toBe(0);
  });

  test("the home directory is removed afterwards", () => {
    expect(home !== "" && existsSync(home)).toBe(false);
  });

  test("the secret file stays untouched", () => {
    expect(statSync(secretFile).uid).toBe(0);
  });

  test("a process the check detached into its own session is stopped", () => {
    expect(processesOf(POOL)).toEqual([]);
  });

  test("the command cannot list the slot locks", () => {
    expect(probed("read_slot_locks")).toBe("denied");
  });

  test("root can run git in the worktree afterwards", () => {
    expect(runSync(["git", "status", "--porcelain"], worktree)).toBe(0);
  });

  test("the Windmill runtime directory is closed to other users", () => {
    expect(statSync(WINDMILL_TMP_DIR).mode & 0o077).toBe(0);
  });

  test("a command that outlives its timeout is stopped with its descendants", async () => {
    const sandbox = createCheckSandbox({
      uids: POOL,
      deps: defaultSandboxDeps(slotLockDir),
    });
    const lockedRun = withWorktreeProcessLock(
      runCommand,
      worktreeLockFor(worktree),
      { kind: "implement", workItemId: 1, jobId: "it" },
    );
    writeFileSync(
      join(worktree, "hang.sh"),
      "setsid sleep 300 >/dev/null 2>&1 &\nsleep 300\n",
    );
    const [result] = await runAllowedCheckCommands(
      lockedRun,
      worktree,
      ["sh ./hang.sh"],
      1_000,
      undefined,
      undefined,
      sandbox,
    );
    expect([result?.timedOut, processesOf(POOL)]).toEqual([true, []]);
  }, 60_000);
});

/** 使い捨てのリポジトリと、そのworktreeを作る。 */
function makeRepo() {
  const base = mkdtempSync("/tmp/check-sandbox-it-");
  chmodSync(base, 0o755);
  const repo = join(base, "repo");
  mkdirSync(repo);
  mustRun(["git", "init", "-q", "."], repo);
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  mustRun(["git", "add", "tracked.txt"], repo);
  mustRun(
    [
      "git",
      "-c",
      "user.name=it",
      "-c",
      "user.email=it@example.com",
      "commit",
      "-q",
      "-m",
      "init",
    ],
    repo,
  );
  return {
    base,
    repo,
    addWorktree: (name: string): string => {
      const dir = join(base, name);
      mustRun(["git", "worktree", "add", "-q", dir, "-b", name], repo);
      return dir;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** ステップと同じ、worktreeのロックの下で検査コマンドを実行するランナー。 */
function lockedRunFor(dir: string, jobId: string) {
  return withWorktreeProcessLock(runCommand, worktreeLockFor(dir), {
    kind: "implement",
    workItemId: 1,
    jobId,
  });
}

function sandboxIn(
  lockDir: string,
  uids: readonly number[],
  opts?: { readonly maxWaitMs?: number; readonly pollMs?: number },
) {
  return createCheckSandbox({
    uids,
    deps: defaultSandboxDeps(lockDir),
    pollMs: 100,
    ...opts,
  });
}

function runChecks(
  dir: string,
  commands: readonly string[],
  sandbox: CheckSandbox,
  timeoutMs = 30_000,
  jobId = "it",
) {
  return runAllowedCheckCommands(
    lockedRunFor(dir, jobId),
    dir,
    commands,
    timeoutMs,
    undefined,
    undefined,
    sandbox,
  );
}

suite("check commands in the flows of the steps", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  let worktree = "";
  let results: Awaited<ReturnType<typeof runChecks>> = [];
  let timedOut: Awaited<ReturnType<typeof runChecks>> = [];
  let afterTimeout: Awaited<ReturnType<typeof runChecks>> = [];

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("flow");
    writeFileSync(join(worktree, "tracked.txt"), "changed\n");
    writeFileSync(
      join(worktree, "pass.test.ts"),
      'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    );
    writeFileSync(
      join(worktree, "fail.test.ts"),
      'import { expect, test } from "bun:test";\ntest("ng", () => { expect(1).toBe(2); });\n',
    );
    const sandbox = sandboxIn(lockDir, POOL);
    results = await runChecks(
      worktree,
      [
        "true",
        "false",
        "git status --porcelain",
        "git diff",
        "git log -1 --format=%H",
        "bun test ./pass.test.ts",
        "bun test ./fail.test.ts",
      ],
      sandbox,
    );
    timedOut = await runChecks(worktree, ["sleep 30"], sandbox, 1_000);
    afterTimeout = await runChecks(worktree, ["true"], sandbox);
  }, 120_000);

  afterAll(() => fx.cleanup());

  const at = (index: number) => results[index];

  test("a passing check is ok", () => {
    expect(at(0)?.ok).toBe(true);
  });

  test("a failing check is not ok", () => {
    expect(at(1)?.ok).toBe(false);
  });

  test("a failing check keeps its exit code", () => {
    expect(at(1)?.exitCode).toBe(1);
  });

  test("git status works as a check", () => {
    expect(at(2)?.ok).toBe(true);
  });

  test("git status lists the change made before the check", () => {
    expect(at(2)?.output).toContain("tracked.txt");
  });

  test("git diff works as a check", () => {
    expect(at(3)?.ok).toBe(true);
  });

  test("git diff shows the change made before the check", () => {
    expect(at(3)?.output).toContain("+changed");
  });

  test("git log works as a check", () => {
    expect(at(4)?.output).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a passing bun test is ok", () => {
    expect(at(5)?.ok).toBe(true);
  });

  test("a passing bun test reports its pass", () => {
    expect(at(5)?.output).toContain("1 pass");
  });

  test("a failing bun test is not ok", () => {
    expect(at(6)?.ok).toBe(false);
  });

  test("a failing bun test reports its failure", () => {
    expect(at(6)?.output).toContain("1 fail");
  });

  test("a check that outlives its timeout is marked timed out", () => {
    expect(timedOut[0]?.timedOut).toBe(true);
  });

  test("a check that outlives its timeout is not ok", () => {
    expect(timedOut[0]?.ok).toBe(false);
  });

  test("no process of any slot is left after a timed-out check", () => {
    expect(processesOf(POOL)).toEqual([]);
  });

  test("the next check after a timed-out check passes", () => {
    expect(afterTimeout[0]?.ok).toBe(true);
  });

  test("the worktree is owned by root after the checks", () => {
    expect(lstatSync(worktree).uid).toBe(0);
  });

  test("the file the checks left is owned by root", () => {
    expect(statSync(join(worktree, "pass.test.ts")).uid).toBe(0);
  });

  test("root can run git in the worktree after the checks", () => {
    expect(runSync(["git", "status", "--porcelain"], worktree)).toBe(0);
  });
});

suite("check slots in the worker image", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const worktrees: string[] = [];
  const who = "id -u\n";
  const sleepThenWho = "sleep 1\nid -u\n";

  beforeAll(() => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      const dir = fx.addWorktree(`slot-${String(index)}`);
      writeFileSync(join(dir, "who.sh"), who);
      writeFileSync(join(dir, "slow.sh"), sleepThenWho);
      worktrees.push(dir);
    }
  }, 60_000);

  afterAll(() => {
    rmSync(join(fx.base, "slots"), { recursive: true, force: true });
    fx.cleanup();
  });

  const dir = (index: number): string => worktrees[index] ?? "";

  test("the image creates one numbered user per slot with the pool's uids", () => {
    expect(
      parsePasswdUsers(readPasswd(), "factory-check-").map((user) => user.uid),
    ).toEqual(POOL);
  });

  test("there are at least as many slots as the worker's processes", () => {
    expect(POOL.length).toBeGreaterThanOrEqual(3);
  });

  test("the host kernel protects hard links and symlinks", () => {
    expect(sandboxIn(lockDir, POOL).kernelWarnings()).toEqual([]);
  });

  test("four concurrent runs use four different uids", async () => {
    const runs = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        runChecks(dir(index), ["sh ./slow.sh"], sandboxIn(lockDir, POOL)),
      ),
    );
    const uids = runs.map((run) => run[0]?.output.trim());
    expect(new Set(uids).size).toBe(4);
  }, 60_000);

  test("every concurrent run uses a uid of the pool", async () => {
    const runs = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        runChecks(dir(index), ["sh ./slow.sh"], sandboxIn(lockDir, POOL)),
      ),
    );
    expect(
      runs.every((run) => POOL.includes(Number(run[0]?.output.trim()))),
    ).toBe(true);
  }, 60_000);

  test("a run cannot write into the worktree of a concurrent run", async () => {
    writeFileSync(join(dir(4), "a.sh"), "sleep 2\n");
    writeFileSync(
      join(dir(5), "b.sh"),
      `sleep 0.5\ntouch ${dir(4)}/made-by-b 2>/dev/null && echo ok || echo denied\n`,
    );
    const [first, second] = await Promise.all([
      runChecks(dir(4), ["sh ./a.sh"], sandboxIn(lockDir, POOL)),
      runChecks(dir(5), ["sh ./b.sh"], sandboxIn(lockDir, POOL)),
    ]);
    expect([first[0]?.ok, second[0]?.output.trim()]).toEqual([true, "denied"]);
  }, 60_000);

  test("a third run waits for a free slot when only two slots exist", async () => {
    const startedAt = Date.now();
    const runs = await Promise.all(
      [0, 1, 2].map((index) =>
        runChecks(
          dir(index),
          ["sh ./slow.sh"],
          sandboxIn(lockDir, POOL.slice(0, 2)),
        ),
      ),
    );
    expect([
      runs.every((run) => run[0]?.ok === true),
      Date.now() - startedAt >= 1_900,
    ]).toEqual([true, true]);
  }, 60_000);

  test("a run fails with a clear error when no slot frees up in time", async () => {
    writeFileSync(join(dir(6), "hold.sh"), "sleep 3\n");
    const holder = runChecks(
      dir(6),
      ["sh ./hold.sh"],
      sandboxIn(lockDir, POOL.slice(0, 1)),
    );
    await Bun.sleep(1_000);
    const waiter = runChecks(
      dir(7),
      ["sh ./who.sh"],
      sandboxIn(lockDir, POOL.slice(0, 1), { maxWaitMs: 500 }),
    );
    await expect(waiter).rejects.toThrow("no check slot became free");
    await holder;
  }, 60_000);

  test("a run that gave up waiting leaves its worktree owned by root", () => {
    expect(lstatSync(dir(7)).uid).toBe(0);
  });

  test("the slot is free again once the holder finished", async () => {
    const run = await runChecks(
      dir(7),
      ["sh ./who.sh"],
      sandboxIn(lockDir, POOL.slice(0, 1)),
    );
    expect(run[0]?.ok).toBe(true);
  }, 60_000);

  test("the slot lock directory is closed to other users", () => {
    expect(statSync(lockDir).mode & 0o777).toBe(0o700);
  });

  test("a slot taken by a process that is killed frees itself", async () => {
    const deps = defaultSandboxDeps(lockDir);
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `import { defaultSandboxDeps } from ${JSON.stringify(join(import.meta.dir, "../../f/factory/lib/check_sandbox.ts"))};
const handle = await defaultSandboxDeps(${JSON.stringify(lockDir)}).slots.tryAcquire(0);
console.log(handle === null ? "busy" : "held");
process.kill(process.pid, "SIGKILL");`,
      ],
      { stdout: "pipe" },
    );
    const said = await new Response(child.stdout).text();
    await child.exited;
    let freed = false;
    for (let attempt = 0; attempt < 50 && !freed; attempt += 1) {
      const again = await deps.slots.tryAcquire(0);
      if (again !== null) {
        freed = true;
        await again.release();
      } else {
        await Bun.sleep(100);
      }
    }
    expect([said.trim(), freed]).toEqual(["held", true]);
  }, 60_000);

  test("a run stops the processes a dead run left in the slot's uid", async () => {
    const uid = POOL[0] ?? 0;
    Bun.spawn(
      [
        SETPRIV,
        `--reuid=${String(uid)}`,
        `--regid=${String(uid)}`,
        "--clear-groups",
        "--",
        "sleep",
        "300",
      ],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    await Bun.sleep(300);
    const before = processesOf([uid]).length;
    await runChecks(dir(0), ["true"], sandboxIn(lockDir, [uid]));
    expect([before, processesOf([uid]).length]).toEqual([1, 0]);
  }, 60_000);

  test("a worktree a cancelled run left owned by a slot uid is taken back", async () => {
    const uid = POOL[1] ?? 0;
    const target = dir(3);
    mustRun(["chown", "-R", `${String(uid)}:${String(uid)}`, target], fx.base);
    Bun.spawn(
      [
        SETPRIV,
        `--reuid=${String(uid)}`,
        `--regid=${String(uid)}`,
        "--clear-groups",
        "--",
        "sleep",
        "300",
      ],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    await Bun.sleep(300);
    const restored = await restoreCheckOwnership(
      target,
      POOL,
      defaultSandboxDeps(lockDir),
    );
    expect([
      restored,
      lstatSync(target).uid,
      processesOf([uid]).length,
      runSync(["git", "status", "--porcelain"], target),
    ]).toEqual([true, 0, 0, 0]);
  }, 60_000);

  test("a worktree owned by root is left alone", async () => {
    expect(
      await restoreCheckOwnership(dir(2), POOL, defaultSandboxDeps(lockDir)),
    ).toBe(false);
  });

  test("the write bits a check set are dropped afterwards", async () => {
    writeFileSync(
      join(dir(1), "loose.sh"),
      "touch loose\nchmod 666 loose\nmkdir loosedir\nchmod 777 loosedir\ntouch setid\nchmod 4755 setid\n",
    );
    await runChecks(dir(1), ["sh ./loose.sh"], sandboxIn(lockDir, POOL));
    const modes = ["loose", "loosedir", "setid"].map(
      (name) => statSync(join(dir(1), name)).mode & 0o6022,
    );
    expect(modes).toEqual([0, 0, 0]);
  }, 60_000);
});
