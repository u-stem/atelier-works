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
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runAllowedCheckCommands } from "../../f/factory/lib/check_runner.ts";
import {
  CHECK_ENV_KEYS,
  CHECK_NPROC_LIMIT,
  CheckRuntimeUnsafeError,
  type CheckSandbox,
  type CheckSlotNotice,
  checkEnvironmentError,
  checkImageProblems,
  createCheckSandbox,
  defaultSandboxDeps,
  listWorldWritablePaths,
  parsePasswdUsers,
  resolveCheckPool,
  restoreCheckOwnership,
  type SlotHandle,
  WINDMILL_TMP_DIR,
} from "../../f/factory/lib/check_sandbox.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  FLOCK_PATH,
  probeWorktreeLock,
  restoreOwnershipStep,
  WorktreeBusyError,
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

/** `dir`の下で拡張のACLを持つものを、`getfacl`の出力で返す。無ければ空の文字列を返す。 */
function extendedAcls(dir: string): string {
  const proc = Bun.spawnSync({
    cmd: ["/usr/bin/getfacl", "-R", "-P", "-s", "-p", "--", dir],
    env: { PATH: "/usr/bin:/bin" },
  });
  return proc.stdout.toString().trim();
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
printf 'open_worktree_lock=%s\\n' "$(cat ${worktreeLockFor(worktree).lockPath} >/dev/null 2>&1 && echo opened || echo denied)"
printf 'tmpdir=%s\\n' "$TMPDIR"
printf 'write_tmpdir=%s\\n' "$(touch "$TMPDIR/made-by-check" 2>/dev/null && echo ok || echo denied)"
printf 'git_status=%s\\n' "$(git status --porcelain >/dev/null 2>&1 && echo ok || echo failed)"
printf 'git_head=%s\\n' "$(git rev-parse --verify HEAD 2>/dev/null)"
printf 'gain_privilege=%s\\n' "$(${SETPRIV} --reuid=0 -- id -u 2>/dev/null || echo denied)"
printf 'max_processes=%s\\n' "$(awk '/^Max processes/{print $3 ":" $4}' /proc/self/limits)"
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

  test("the command's process count is capped for its uid", () => {
    expect(probed("max_processes")).toBe(
      `${String(CHECK_NPROC_LIMIT)}:${String(CHECK_NPROC_LIMIT)}`,
    );
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

  test("the command cannot open the worktree's lock file", () => {
    expect(probed("open_worktree_lock")).toBe("denied");
  });

  test("the worktree's lock file is readable only by root", () => {
    expect(statSync(worktreeLockFor(worktree).lockPath).mode & 0o777).toBe(
      0o600,
    );
  });

  test("the command's TMPDIR is inside its home", () => {
    expect(probed("tmpdir")).toBe(`${home}/tmp`);
  });

  test("the command can write to its TMPDIR", () => {
    expect(probed("write_tmpdir")).toBe("ok");
  });

  test("no slot record is left after a completed run", () => {
    expect(
      readdirSync(slotLockDir).filter((name) => name.endsWith(".state")),
    ).toEqual([]);
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

  test("the worker image meets every prerequisite of the sandbox", async () => {
    expect(await checkImageProblems(POOL, defaultSandboxDeps(lockDir))).toEqual(
      { image: [], runtime: [] },
    );
  });

  test("a slot cannot add a file next to the Windmill binary root runs", () => {
    expect(runAsUid(POOL[0] ?? 0, "touch /usr/src/app/planted", "/")).not.toBe(
      0,
    );
  });

  test("nothing in the Windmill directory is writable by the group or others", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "/usr/bin/find",
        "/usr/src/app",
        "-xdev",
        "!",
        "-type",
        "l",
        "-perm",
        "/022",
      ],
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(proc.stdout.toString()).toBe("");
  });

  test("a slot cannot open the Windmill binary for writing", () => {
    expect(
      runAsUid(POOL[0] ?? 0, "exec 3>>/usr/src/app/windmill", "/"),
    ).not.toBe(0);
  });

  test("a slot cannot open the library Windmill loads from its directory for writing", () => {
    expect(
      runAsUid(
        POOL[0] ?? 0,
        "exec 3>>/usr/src/app/libwindmill_duckdb_ffi_internal.so",
        "/",
      ),
    ).not.toBe(0);
  });

  test("a slot can write only into the shared temporary directories outside the worktree and its home", async () => {
    expect(await defaultSandboxDeps(lockDir).listWorldWritablePaths()).toEqual(
      [],
    );
  });

  // `scripts/verify-check-sandbox.sh`は、workerと同じくボリュームをマウントする。
  // `-xdev`でもマウントポイントそのものは走査に当たるので、誰でも書ける権限なら毎回止まる。
  test.each(["/workspaces", "/var/lib/factory"])(
    "the volume mounted at %s is root's and closed to others",
    (path) => {
      const stat = statSync(path);
      expect({ uid: stat.uid, mode: stat.mode & 0o7777 }).toEqual({
        uid: 0,
        mode: 0o755,
      });
    },
  );

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

  test("a worktree no slot recorded is left alone", async () => {
    expect(
      await restoreCheckOwnership(dir(2), POOL, defaultSandboxDeps(lockDir)),
    ).toBe(false);
  });

  test("a directory the check closed to itself is taken back", async () => {
    writeFileSync(
      join(dir(2), "close.sh"),
      "mkdir closed\ntouch closed/f\nchmod 666 closed/f\nchmod 000 closed\n",
    );
    await runChecks(dir(2), ["sh ./close.sh"], sandboxIn(lockDir, POOL));
    const file = statSync(join(dir(2), "closed", "f"));
    expect([file.uid, file.mode & 0o022]).toEqual([0, 0]);
  }, 60_000);

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

  test("a check that keeps forking in its own session is stopped", async () => {
    writeFileSync(
      join(dir(3), "fork.sh"),
      "setsid sh -c 'while :; do sleep 300 & sleep 0.01; done' >/dev/null 2>&1 &\nsleep 1\n",
    );
    await runChecks(
      dir(3),
      ["sh ./fork.sh"],
      sandboxIn(lockDir, [POOL[6] ?? 0]),
    );
    expect(processesOf(POOL)).toEqual([]);
  }, 120_000);

  test("a run sets aside a slot record it cannot read and still uses the slot", async () => {
    const corruptDir = join(fx.base, "slots-corrupt");
    mkdirSync(corruptDir, { mode: 0o700 });
    writeFileSync(join(corruptDir, "slot-0.state"), "{");
    const notices: CheckSlotNotice[] = [];
    const sandbox = createCheckSandbox({
      uids: [POOL[7] ?? 0],
      deps: defaultSandboxDeps(corruptDir),
      pollMs: 100,
      onNotice: async (notice) => {
        notices.push(notice);
      },
    });
    const run = await runChecks(dir(5), ["true"], sandbox);
    const setAside = readdirSync(corruptDir).filter((name) =>
      name.startsWith("slot-0.state.corrupt-"),
    );
    expect([
      run[0]?.ok,
      notices.map((notice) => notice.kind),
      setAside.length,
    ]).toEqual([true, ["check_slot_record_unreadable"], 1]);
  }, 60_000);
});

suite("ACLs a check leaves in the worktree", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[1] ?? 0;
  const other = POOL[2] ?? 0;
  let worktree = "";
  let set = "";

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("acl");
    writeFileSync(
      join(worktree, "acl.sh"),
      [
        "mkdir open-default",
        "setfacl -d -m o::rwx open-default",
        "touch named",
        `setfacl -m u:${String(other)}:rwx named`,
        `getfacl -s -p open-default named | grep -c '^# file'`,
        "",
      ].join("\n"),
    );
    const [result] = await runChecks(
      worktree,
      ["sh ./acl.sh"],
      sandboxIn(lockDir, [uid]),
    );
    set = result?.output.trim() ?? "";
    // 取り戻した後に、rootが同じディレクトリにファイルを作る(次のラウンドのClaudeやgitに当たる)。
    writeFileSync(join(worktree, "open-default", "by-root"), "x\n");
  }, 60_000);

  afterAll(() => fx.cleanup());

  test("the check could set a default ACL and a named entry", () => {
    expect(set).toBe("2");
  });

  test("a file root creates later in that directory is not writable by others", () => {
    expect(
      statSync(join(worktree, "open-default", "by-root")).mode & 0o022,
    ).toBe(0);
  });

  test("no entry of the worktree keeps an extended ACL", () => {
    expect(extendedAcls(worktree)).toBe("");
  });

  test("the slot record is cleared once the ACLs are gone", () => {
    expect(
      readdirSync(lockDir).filter((name) => name.endsWith(".state")),
    ).toEqual([]);
  });
});

/** `setpriv`で`uid`に落としてシェルのスクリプトを実行し、終了コードを返す。 */
function runAsUid(uid: number, script: string, cwd: string): number {
  return runSync(
    [
      SETPRIV,
      `--reuid=${String(uid)}`,
      `--regid=${String(uid)}`,
      "--clear-groups",
      "--",
      "/bin/sh",
      "-c",
      script,
    ],
    cwd,
  );
}

/** 検査用のHOMEを、`runAllowedCheckCommands`の既定と同じ形で作る。 */
function makeHome(): string {
  const dir = mkdtempSync("/tmp/factory-check-home-");
  mkdirSync(join(dir, "tmp"), { mode: 0o700 });
  return dir;
}

/**
 * 取り消された実行を再現する。別のプロセスで、空いている先頭の枠(枠0)を取ってworktreeとHOMEを渡し、
 * 枠のuidで`script`を実行し、別のセッションに抜けたプロセスを残してから、そのプロセスごと殺す。
 * 後始末は走らないので、枠の記録と所有権とプロセスが残る。
 */
async function cancelledRun(opts: {
  readonly lockDir: string;
  readonly worktreeDir: string;
  readonly homeDir: string;
  readonly script: string;
}): Promise<string> {
  const module = join(import.meta.dir, "../../f/factory/lib/check_sandbox.ts");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { createCheckSandbox, defaultSandboxDeps } from ${JSON.stringify(module)};
const sandbox = createCheckSandbox({ uids: ${JSON.stringify(POOL)}, deps: defaultSandboxDeps(${JSON.stringify(opts.lockDir)}) });
const dirs = { worktreeDir: ${JSON.stringify(opts.worktreeDir)}, homeDir: ${JSON.stringify(opts.homeDir)} };
await sandbox.prepare(dirs);
const env = { PATH: "/usr/bin:/bin", HOME: dirs.homeDir };
Bun.spawnSync({ cmd: sandbox.wrap(["/bin/sh", "-c", ${JSON.stringify(opts.script)}]), cwd: dirs.worktreeDir, env });
Bun.spawn({ cmd: sandbox.wrap(["/usr/bin/setsid", "/bin/sleep", "300"]), cwd: dirs.worktreeDir, env, stdio: ["ignore", "ignore", "ignore"] });
await Bun.sleep(300);
console.log("prepared");
process.kill(process.pid, "SIGKILL");`,
    ],
    { stdout: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
  );
  const said = await new Response(child.stdout).text();
  await child.exited;
  // 殺したプロセスの下でロックを持っていた`flock`が、パイプの終わりを見て抜けるのを待つ。
  await Bun.sleep(300);
  return said.trim();
}

suite("recovery of a slot a cancelled run left", () => {
  const first = makeRepo();
  const second = makeRepo();
  const lockDir = join(first.base, "slots");
  const uid = POOL[0] ?? 0;
  let stale = "";
  let staleHome = "";
  let said = "";
  let outputs = new Map<string, string>();

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    stale = first.addWorktree("cancelled");
    staleHome = makeHome();
    said = await cancelledRun({
      lockDir,
      worktreeDir: stale,
      homeDir: staleHome,
      script: "mkdir open && chmod 777 open && chmod 777 .",
    });
    const next = second.addWorktree("next");
    writeFileSync(
      join(next, "attack.sh"),
      [
        `printf 'write_top=%s\\n' "$(touch ${stale}/made-by-next 2>/dev/null && echo ok || echo denied)"`,
        `printf 'write_open=%s\\n' "$(touch ${stale}/open/made-by-next 2>/dev/null && echo ok || echo denied)"`,
        `printf 'read_home=%s\\n' "$(ls ${staleHome} >/dev/null 2>&1 && echo readable || echo gone)"`,
        "",
      ].join("\n"),
    );
    const [result] = await runChecks(
      next,
      ["sh ./attack.sh"],
      sandboxIn(lockDir, [uid]),
    );
    outputs = parseProbeOutput(result?.output ?? "");
  }, 120_000);

  afterAll(() => {
    rmSync(staleHome, { recursive: true, force: true });
    first.cleanup();
    second.cleanup();
  });

  test("the cancelled run had handed its worktree over", () => {
    expect(said).toBe("prepared");
  });

  test("the next run on the same slot cannot write to the old worktree", () => {
    expect(outputs.get("write_top")).toBe("denied");
  });

  test("the next run cannot write to a directory the old run opened to everyone", () => {
    expect(outputs.get("write_open")).toBe("denied");
  });

  test("the next run cannot see the old run's home", () => {
    expect(outputs.get("read_home")).toBe("gone");
  });

  test("the old worktree is owned by root again", () => {
    expect(lstatSync(stale).uid).toBe(0);
  });

  test("the old worktree is no longer open to everyone", () => {
    expect(lstatSync(stale).mode & 0o022).toBe(0);
  });

  test("the directory the old run opened is closed again", () => {
    expect(statSync(join(stale, "open")).mode & 0o022).toBe(0);
  });

  test("the process the old run left is stopped", () => {
    expect(processesOf([uid])).toEqual([]);
  });

  test("root can run git in the old worktree again", () => {
    expect(runSync(["git", "status", "--porcelain"], stale)).toBe(0);
  });

  test("the slot record of the old run is gone", () => {
    expect(
      readdirSync(lockDir).filter((name) => name.endsWith(".state")),
    ).toEqual([]);
  });
});

suite("restoring a worktree from the slot record", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[0] ?? 0;
  let worktree = "";
  let staleHome = "";
  let restored = false;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("partial");
    staleHome = makeHome();
    await cancelledRun({
      lockDir,
      worktreeDir: worktree,
      homeDir: staleHome,
      script:
        "mkdir open && chmod 777 open && touch open/f && chmod 666 open/f",
    });
    // 取り戻しが途中で止まった状態にする。最上位だけがrootに戻り、中は枠のuidのまま残る。
    mustRun(["chown", "0:0", worktree], fx.base);
    restored = await restoreCheckOwnership(
      worktree,
      POOL,
      defaultSandboxDeps(lockDir),
    );
  }, 60_000);

  afterAll(() => {
    rmSync(staleHome, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the record is used even though root owns the top directory", () => {
    expect(restored).toBe(true);
  });

  test("an entry the old run left inside is owned by root", () => {
    expect(statSync(join(worktree, "open", "f")).uid).toBe(0);
  });

  test("a directory the old run opened is closed again", () => {
    expect(statSync(join(worktree, "open")).mode & 0o022).toBe(0);
  });

  test("a file the old run opened is closed again", () => {
    expect(statSync(join(worktree, "open", "f")).mode & 0o022).toBe(0);
  });

  test("the process the old run left is stopped", () => {
    expect(processesOf([uid])).toEqual([]);
  });

  test("the home the old run recorded is removed", () => {
    expect(existsSync(staleHome)).toBe(false);
  });
});

/** System Vの共有メモリのうち、所有者か作成者が`owner`のものの数。 */
function shmOf(owner: number): number {
  return readFileSync("/proc/sysvipc/shm", "utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields) => fields[7] === String(owner) || fields[9] === String(owner),
    ).length;
}

/** 共有の一時ディレクトリに、名前が`tag`で始まるファイルとディレクトリを置き、共有メモリを1つ作るスクリプト。 */
function leaveSharedScript(tag: string): string {
  return [
    "umask 077",
    `echo secret > /tmp/${tag}-file`,
    `mkdir /tmp/${tag}-dir && chmod 777 /tmp/${tag}-dir && echo secret > /tmp/${tag}-dir/inner`,
    `echo secret > /var/tmp/${tag}-file`,
    `echo secret > /dev/shm/${tag}-file`,
    "ipcmk -M 4096 >/dev/null",
    "",
  ].join("\n");
}

/** `leaveSharedScript`が置くパス。 */
function sharedPaths(tag: string): string[] {
  return [
    `/tmp/${tag}-file`,
    `/tmp/${tag}-dir`,
    `/var/tmp/${tag}-file`,
    `/dev/shm/${tag}-file`,
  ];
}

suite("shared temporary files between runs on one slot", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[2] ?? 0;
  const tag = `it-${String(process.pid)}`;
  const paths = sharedPaths(tag);
  let created: boolean[] = [];
  let ipcBefore = 0;
  let seen: string[] = [];

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    const worktree = fx.addWorktree("shared");
    // 後始末が走らなかった実行の残りを、枠のuidで直に作って再現する。
    runAsUid(uid, leaveSharedScript(tag), "/");
    created = paths.map((path) => existsSync(path));
    ipcBefore = shmOf(uid);
    // 別の枠のuidが、残ったディレクトリの中にファイルを置く。
    runAsUid(POOL[3] ?? 0, `echo x > /tmp/${tag}-dir/by-other`, "/");
    // 次の実行の検査の中から、残りが見えるかを確かめる。終わった後の後始末より前に消えていることを見るためである。
    writeFileSync(
      join(worktree, "look.sh"),
      [
        ...paths.map((path) => `test -e ${path} && echo present || echo gone`),
        `awk 'NR > 1 && ($8 == ${String(uid)} || $10 == ${String(uid)})' /proc/sysvipc/shm | wc -l`,
        "",
      ].join("\n"),
    );
    const [result] = await runChecks(
      worktree,
      ["sh ./look.sh"],
      sandboxIn(lockDir, [uid]),
    );
    seen = (result?.output ?? "").trim().split("\n");
  }, 60_000);

  afterAll(() => {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the dead run left its files in the shared directories", () => {
    expect(created).toEqual([true, true, true, true]);
  });

  test("the dead run left a shared memory segment", () => {
    expect(ipcBefore).toBe(1);
  });

  test.each([0, 1, 2, 3])(
    "the next run on the slot removed shared path %d before its check",
    (index) => {
      expect(seen[index]).toBe("gone");
    },
  );

  test("the next run on the slot removed the shared memory segment before its check", () => {
    expect(seen[4]?.trim()).toBe("0");
  });
});

suite("shared temporary files a finished check leaves", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[3] ?? 0;
  const tag = `it-done-${String(process.pid)}`;
  const paths = sharedPaths(tag);
  let ok: boolean | undefined;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    const worktree = fx.addWorktree("shared-done");
    writeFileSync(join(worktree, "leave.sh"), leaveSharedScript(tag));
    const [result] = await runChecks(
      worktree,
      ["sh ./leave.sh"],
      sandboxIn(lockDir, [uid]),
    );
    ok = result?.ok;
  }, 60_000);

  afterAll(() => {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the check could write to the shared directories", () => {
    expect(ok).toBe(true);
  });

  test.each([0, 1, 2, 3])(
    "the check's own release removed shared path %d",
    (index) => {
      expect(existsSync(paths[index] ?? "")).toBe(false);
    },
  );

  test("the check's own release removed its shared memory segment", () => {
    expect(shmOf(uid)).toBe(0);
  });
});

suite("entries another slot adds during a check", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[4] ?? 0;
  const other = POOL[5] ?? 0;
  const victim = join(fx.base, "victim");
  /** 別の枠が自分の所有で作り、worktreeへハードリンクするworktreeの外のファイル。 */
  const ownFile = `/tmp/check-sandbox-it-own-${String(process.pid)}`;
  let worktree = "";
  let added = -1;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("foreign");
    writeFileSync(victim, "x\n");
    chmodSync(victim, 0o666);
    writeFileSync(
      join(worktree, "open.sh"),
      "mkdir shared && chmod 777 shared && touch shared/.ready && sleep 3\n",
    );
    const running = runChecks(
      worktree,
      ["sh ./open.sh"],
      sandboxIn(lockDir, [uid]),
    );
    const ready = join(worktree, "shared", ".ready");
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(50);
    }
    added = runAsUid(
      other,
      [
        "mkdir shared/b-dir && chmod 777 shared/b-dir",
        "touch shared/b-file && chmod 666 shared/b-file",
        `ln -s ${victim} shared/b-link`,
        "mkdir shared/b-acl && setfacl -d -m o::rwx shared/b-acl",
        `touch ${ownFile} && chmod 666 ${ownFile} && ln ${ownFile} shared/b-hardlink`,
      ].join(" && "),
      worktree,
    );
    await running;
    writeFileSync(join(worktree, "shared", "b-acl", "by-root"), "x\n");
  }, 60_000);

  afterAll(() => {
    fx.cleanup();
    rmSync(ownFile, { force: true });
  });

  test("the other slot could add entries while the check ran", () => {
    expect(added).toBe(0);
  });

  test("a directory the other slot added is owned by root afterwards", () => {
    expect(lstatSync(join(worktree, "shared", "b-dir")).uid).toBe(0);
  });

  test("a directory the other slot added is closed afterwards", () => {
    expect(lstatSync(join(worktree, "shared", "b-dir")).mode & 0o022).toBe(0);
  });

  test("a file the other slot added is closed afterwards", () => {
    expect(lstatSync(join(worktree, "shared", "b-file")).mode & 0o022).toBe(0);
  });

  test("a symlink the other slot added is removed afterwards because it points outside", () => {
    expect(existsSync(join(worktree, "shared", "b-link"))).toBe(false);
  });

  test("the target of that symlink keeps its mode", () => {
    expect(statSync(victim).mode & 0o777).toBe(0o666);
  });

  test("a file root creates later in a directory the other slot gave a default ACL is not writable by others", () => {
    expect(
      statSync(join(worktree, "shared", "b-acl", "by-root")).mode & 0o022,
    ).toBe(0);
  });

  test("the file outside the worktree the other slot hard-linked in is owned by root afterwards", () => {
    expect(lstatSync(ownFile).uid).toBe(0);
  });

  test("the file outside the worktree the other slot hard-linked in is closed afterwards", () => {
    expect(lstatSync(ownFile).mode & 0o022).toBe(0);
  });
});

suite("a hard link a check makes to a writable file of root", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[6] ?? 0;
  const rootFile = join(fx.base, "root-writable");
  let worktree = "";
  let outcome = "";

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("hardlink");
    writeFileSync(rootFile, "x\n");
    chmodSync(rootFile, 0o666);
    writeFileSync(join(worktree, "link.sh"), `ln ${rootFile} linked\n`);
    outcome = await runChecks(
      worktree,
      ["sh ./link.sh"],
      sandboxIn(lockDir, [uid]),
    )
      .then(() => "taken back")
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
  }, 60_000);

  afterAll(() => fx.cleanup());

  test("the check could link the file into the worktree", () => {
    expect(statSync(join(worktree, "linked")).ino).toBe(statSync(rootFile).ino);
  });

  test("taking the worktree back fails on the writable link instead of leaving it", () => {
    expect(outcome).toContain("writable by others remain");
  });

  test("the linked file outside the worktree keeps its mode", () => {
    expect(statSync(rootFile).mode & 0o777).toBe(0o666);
  });

  test("the linked file outside the worktree stays owned by root", () => {
    expect(statSync(rootFile).uid).toBe(0);
  });
});

/**
 * 取り消された実行のうち、worktreeのロックの下で検査コマンドを起動し、別のセッションに抜けたプロセスを残したものを再現する。
 * 残ったプロセスは枠のuidで動き、worktreeのロックを受け継いで持ち続ける。
 */
async function cancelledLockedRun(opts: {
  readonly lockDir: string;
  readonly worktreeDir: string;
  readonly homeDir: string;
}): Promise<string> {
  const module = (name: string): string =>
    JSON.stringify(join(import.meta.dir, `../../f/factory/lib/${name}`));
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { createCheckSandbox, defaultSandboxDeps } from ${module("check_sandbox.ts")};
import { withWorktreeProcessLock, worktreeLockFor } from ${module("process_lock.ts")};
import { runCommand } from ${module("workspace.ts")};
const sandbox = createCheckSandbox({ uids: ${JSON.stringify(POOL)}, deps: defaultSandboxDeps(${JSON.stringify(opts.lockDir)}) });
const dirs = { worktreeDir: ${JSON.stringify(opts.worktreeDir)}, homeDir: ${JSON.stringify(opts.homeDir)} };
await sandbox.prepare(dirs);
const run = withWorktreeProcessLock(runCommand, worktreeLockFor(dirs.worktreeDir), { kind: "implement", workItemId: 1, jobId: "cancelled" });
await run(sandbox.wrap(["/bin/sh", "-c", "setsid sleep 300 </dev/null >/dev/null 2>&1 & sleep 0.3"]), { cwd: dirs.worktreeDir, env: { PATH: "/usr/bin:/bin", HOME: dirs.homeDir } });
console.log("prepared");
process.kill(process.pid, "SIGKILL");`,
    ],
    { stdout: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
  );
  const said = await new Response(child.stdout).text();
  await child.exited;
  // 殺したプロセスの下で枠のロックを持っていた`flock`が、パイプの終わりを見て抜けるのを待つ。
  await Bun.sleep(300);
  return said.trim();
}

suite("a worktree lock a cancelled check keeps", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[0] ?? 0;
  let worktree = "";
  let staleHome = "";
  let said = "";
  let heldBefore = "";
  let whileSlotHeld: unknown = null;
  let afterRestore: unknown = null;
  let heldAfter = "";

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("locked");
    staleHome = makeHome();
    said = await cancelledLockedRun({
      lockDir,
      worktreeDir: worktree,
      homeDir: staleHome,
    });
    const lock = worktreeLockFor(worktree);
    heldBefore = await probeWorktreeLock({ run: runCommand, lock });
    const ensure = () =>
      ensureWorktreeLockFree({
        run: runCommand,
        lock,
        policy: null,
        deps: {
          ...defaultLockReleaseDeps(200),
          restoreOwnership: restoreOwnershipStep((dir) =>
            restoreCheckOwnership(dir, POOL, defaultSandboxDeps(lockDir), 500),
          ),
        },
      });
    // 別の実行が枠を持っている間は、worktreeに触れずに引き返す。
    const slot: SlotHandle | null =
      await defaultSandboxDeps(lockDir).slots.tryAcquire(0);
    try {
      whileSlotHeld = await ensure().then(
        () => "returned",
        (error: unknown) => error,
      );
    } finally {
      await slot?.release();
    }
    afterRestore = await ensure().then(
      (stopped) => stopped,
      (error: unknown) => error,
    );
    heldAfter = await probeWorktreeLock({ run: runCommand, lock });
  }, 120_000);

  afterAll(() => {
    rmSync(staleHome, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the cancelled run left a process holding the worktree lock", () => {
    expect([said, heldBefore]).toEqual(["prepared", "held"]);
  });

  test("the worktree stays busy while another run holds the slot", () => {
    expect(whileSlotHeld).toBeInstanceOf(WorktreeBusyError);
  });

  test("the next step goes on once the slot is free", () => {
    expect(afterRestore).toEqual([]);
  });

  test("the worktree lock is free afterwards", () => {
    expect(heldAfter).toBe("free");
  });

  test("the process the cancelled run left is stopped", () => {
    expect(processesOf([uid])).toEqual([]);
  });

  test("the worktree is owned by root again", () => {
    expect(lstatSync(worktree).uid).toBe(0);
  });

  test("root can run git in the worktree again", () => {
    expect(runSync(["git", "status", "--porcelain"], worktree)).toBe(0);
  });
});

/**
 * 枠を取った実行が、`runCommand`で検査コマンドを起動し、検査コマンドが別のセッションに抜けたプロセスを残してから、
 * 走らせている側のプロセスごと殺されたところを再現する。枠のロックは、走らせている側が持つパイプが閉じると解放される。
 * 抜けたプロセスがそのパイプを受け継いでいると、ロックが解放されないままになる。
 */
async function killedRunWithEscapedCheck(opts: {
  readonly lockDir: string;
  readonly worktreeDir: string;
  readonly homeDir: string;
}): Promise<string> {
  const module = (name: string): string =>
    JSON.stringify(join(import.meta.dir, `../../f/factory/lib/${name}`));
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { createCheckSandbox, defaultSandboxDeps } from ${module("check_sandbox.ts")};
import { runCommand } from ${module("workspace.ts")};
const sandbox = createCheckSandbox({ uids: ${JSON.stringify(POOL)}, deps: defaultSandboxDeps(${JSON.stringify(opts.lockDir)}) });
const dirs = { worktreeDir: ${JSON.stringify(opts.worktreeDir)}, homeDir: ${JSON.stringify(opts.homeDir)} };
await sandbox.prepare(dirs);
await runCommand(sandbox.wrap(["/bin/sh", "-c", "setsid sleep 300 </dev/null >/dev/null 2>&1 & sleep 0.3"]), { cwd: dirs.worktreeDir, env: { PATH: "/usr/bin:/bin", HOME: dirs.homeDir } });
console.log("prepared");
process.kill(process.pid, "SIGKILL");`,
    ],
    { stdout: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
  );
  const said = await new Response(child.stdout).text();
  await child.exited;
  return said.trim();
}

suite("the slot lock of a run killed while its check escaped", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[0] ?? 0;
  let worktree = "";
  let staleHome = "";
  let said = "";
  let escapedAlive = false;
  let freed = false;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("escaped");
    staleHome = makeHome();
    said = await killedRunWithEscapedCheck({
      lockDir,
      worktreeDir: worktree,
      homeDir: staleHome,
    });
    const deps = defaultSandboxDeps(lockDir);
    for (let attempt = 0; attempt < 50 && !freed; attempt += 1) {
      escapedAlive = processesOf([uid]).length > 0;
      const handle = await deps.slots.tryAcquire(0);
      if (handle !== null) {
        freed = true;
        await handle.release();
      } else {
        await Bun.sleep(100);
      }
    }
    // 抜けたプロセスを止め、worktreeをrootに戻す。
    await restoreCheckOwnership(worktree, POOL, deps);
  }, 60_000);

  afterAll(() => {
    rmSync(staleHome, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the killed run had started its check", () => {
    expect(said).toBe("prepared");
  });

  test("the escaped process still runs when the slot frees", () => {
    expect(escapedAlive).toBe(true);
  });

  test("the slot frees although the escaped process still runs", () => {
    expect(freed).toBe(true);
  });

  test("restoring the worktree stops the escaped process", () => {
    expect(processesOf([uid])).toEqual([]);
  });
});

suite("world-writable paths created while the worker runs", () => {
  const slot = POOL[0] ?? 0;
  const created: string[] = [];
  /** rootで作り、`mode`にする。 */
  const rootDir = (path: string, mode: number): string => {
    mkdirSync(path);
    chmodSync(path, mode);
    created.push(path);
    return path;
  };
  let listed: readonly string[] = [];

  beforeAll(async () => {
    rootDir("/tmp/factory-it-root-open", 0o777);
    rootDir("/tmp/factory-it-root-sticky", 0o1777);
    rootDir("/var/tmp/factory-it-root-open", 0o777);
    const slotDir = "/tmp/factory-it-slot-open";
    mustRun(
      [
        SETPRIV,
        `--reuid=${String(slot)}`,
        `--regid=${String(slot)}`,
        "--clear-groups",
        "--",
        "/bin/sh",
        "-c",
        `mkdir ${slotDir} && chmod 0777 ${slotDir}`,
      ],
      "/",
    );
    created.push(slotDir);
    rootDir("/dev/shm/factory-it-root-open", 0o777);
    for (const openFile of [
      "/etc/factory-it-open",
      "/tmp/factory-it-open-file",
      "/tmp/.cache/factory-it-open-file",
    ]) {
      writeFileSync(openFile, "");
      chmodSync(openFile, 0o666);
      created.push(openFile);
    }
    listed = await listWorldWritablePaths(runCommand);
  });

  afterAll(() => {
    for (const path of created) rmSync(path, { recursive: true, force: true });
  });

  test("a directory root left open under /tmp is listed", () => {
    expect(listed).toContain("/tmp/factory-it-root-open");
  });

  test("a directory root left open under /var/tmp is listed", () => {
    expect(listed).toContain("/var/tmp/factory-it-root-open");
  });

  test("a sticky directory of root under /tmp is not listed", () => {
    expect(listed).not.toContain("/tmp/factory-it-root-sticky");
  });

  test("a directory a slot opened under /tmp is not listed", () => {
    expect(listed).not.toContain("/tmp/factory-it-slot-open");
  });

  test("a world-writable file outside the shared directories is listed", () => {
    expect(listed).toContain("/etc/factory-it-open");
  });

  // `/dev/shm`は別のファイルシステムなので、`/`からの`-xdev`の走査には入らず、別の起点からたどる。
  test("a directory root left open under /dev/shm is listed", () => {
    expect(listed).toContain("/dev/shm/factory-it-root-open");
  });

  test("a world-writable file of root under /tmp is not listed", () => {
    expect(listed).not.toContain("/tmp/factory-it-open-file");
  });

  // `/tmp/.cache`はベースのイメージが開いている場所で、ビルドで閉じるので、共有の一時ディレクトリの緩和を当てない。
  test("a world-writable file under /tmp/.cache is listed", () => {
    expect(listed).toContain("/tmp/.cache/factory-it-open-file");
  });

  test("the shared temporary directories themselves are not listed", () => {
    expect(
      listed.filter((path) =>
        ["/tmp", "/var/tmp", "/run/lock", "/dev/shm"].includes(path),
      ),
    ).toEqual([]);
  });

  test("a runtime path stops the checks as a runtime problem, not a stale image", async () => {
    expect(
      checkEnvironmentError(
        await checkImageProblems(POOL, defaultSandboxDeps()),
      ),
    ).toBeInstanceOf(CheckRuntimeUnsafeError);
  });
});

suite("symlinks a check leaves pointing outside the worktree", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  let worktree = "";
  let detected = "";
  let scanCommand = "";
  let ownerOfHardLinkedFile = -1;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("links");
    // 準備の時点で既にある、外を指すsymlink。追跡されているものにあたる。
    symlinkSync("/etc/hostname", join(worktree, "keep"));
    // ハードリンクがあると、受け渡しはディレクトリごとの方法に切り替わる。
    writeFileSync(join(worktree, "one.txt"), "x\n");
    linkSync(join(worktree, "one.txt"), join(worktree, "two.txt"));
    writeFileSync(
      join(worktree, "links.sh"),
      [
        "mkdir -p a/b",
        // 途中のsymlinkを経由する`..`で、worktreeの外の、まだ無いファイルを指す。
        "ln -s ../.. a/b/il",
        "ln -s il/../outside/new.txt a/b/x",
        "ln -s /etc/passwd evil",
        "ln -s ../ok a/inside",
        "touch ok",
        // 名前の上限(255)を超える1要素。
        'ln -s "$(printf "x%.0s" $(seq 1 300))" long300',
        // 道具が置く、外を指す正当なsymlink。
        "mkdir -p .venv/bin",
        "ln -s /usr/bin/python3 .venv/bin/python3",
        // 準備の時点にあったsymlinkの中身を書き換える。
        "rm keep",
        "ln -s /etc/shadow keep",
        "",
      ].join("\n"),
    );
    const results = await runChecks(
      worktree,
      ["sh ./links.sh"],
      sandboxIn(lockDir, POOL),
    );
    const scanned = results.at(-1);
    detected = scanned?.output ?? "";
    scanCommand = scanned?.command ?? "";
    ownerOfHardLinkedFile = lstatSync(join(worktree, "one.txt")).uid;
  }, 60_000);

  afterAll(() => {
    fx.cleanup();
  });

  test("the scan is added as a failed check because a tracked symlink changed", () => {
    expect(scanCommand).toBe("check sandbox: symlink scan");
  });

  test("the changed symlink is named", () => {
    expect(detected).toContain(join(worktree, "keep"));
  });

  test("the changed symlink is restored to its original content", () => {
    expect(readlinkSync(join(worktree, "keep"))).toBe("/etc/hostname");
  });

  test("a symlink to an existing file outside is removed", () => {
    expect(existsSync(join(worktree, "evil"))).toBe(false);
  });

  test("a symlink to an existing file outside is not named in the failure", () => {
    expect(detected).not.toContain(join(worktree, "evil"));
  });

  test("a dangling symlink through another symlink and .. is removed", () => {
    expect(() => lstatSync(join(worktree, "a/b/x"))).toThrow();
  });

  test("a symlink with a component beyond the name limit is removed", () => {
    expect(() => lstatSync(join(worktree, "long300"))).toThrow();
  });

  test("a symlink a tool places to a system file is removed", () => {
    expect(() => lstatSync(join(worktree, ".venv/bin/python3"))).toThrow();
  });

  test("a symlink that stays inside the worktree is kept", () => {
    expect(lstatSync(join(worktree, "a/inside")).isSymbolicLink()).toBe(true);
  });

  test("the file with a hard link is owned by root afterwards", () => {
    expect(ownerOfHardLinkedFile).toBe(0);
  });
});

suite("a tool's symlink to a system file", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  let worktree = "";
  let resultCount = -1;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("venv");
    writeFileSync(
      join(worktree, "venv.sh"),
      "mkdir -p .venv/bin\nln -s /usr/bin/python3 .venv/bin/python3\n",
    );
    const results = await runChecks(
      worktree,
      ["sh ./venv.sh"],
      sandboxIn(lockDir, POOL),
    );
    resultCount = results.length;
  }, 60_000);

  afterAll(() => {
    fx.cleanup();
  });

  test("does not add a failed check", () => {
    expect(resultCount).toBe(1);
  });

  test("is removed", () => {
    expect(() => lstatSync(join(worktree, ".venv/bin/python3"))).toThrow();
  });
});

suite("an incomplete symlink scan", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  let worktree = "";
  let detected = "";
  let names: string[] = [];

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("incomplete");
    writeFileSync(
      join(worktree, "incomplete.sh"),
      [
        "touch ok",
        "ln -s /etc/passwd evil",
        "ln -s ../ok dotdot",
        "ln -s ok inside",
        // 省いた印を、名前にしたもの。
        "ln -s /etc/passwd '[... 5 bytes omitted ...]'",
        // UTF-8でない名前。
        'ln -s /etc/passwd "$(printf "bad\\377")"',
        "",
      ].join("\n"),
    );
    const results = await runChecks(
      worktree,
      ["sh ./incomplete.sh"],
      sandboxIn(lockDir, POOL),
    );
    detected = results.at(-1)?.output ?? "";
    names = readdirSync(worktree);
  }, 60_000);

  afterAll(() => {
    // UTF-8でない名前は、Node由来の`rmSync`では消せない。
    Bun.spawnSync(["rm", "-rf", fx.base]);
  });

  test("the failed check says every symlink with an absolute or .. content was removed", () => {
    expect(detected).toContain("was incomplete, so every symlink");
  });

  test("a symlink to an absolute path is removed", () => {
    expect(names).not.toContain("evil");
  });

  test("a symlink with .. in its content is removed", () => {
    expect(names).not.toContain("dotdot");
  });

  test("a symlink named like the omission marker is removed", () => {
    expect(names.filter((name) => name.includes("omitted"))).toEqual([]);
  });

  test("a symlink with a name that is not UTF-8 is removed", () => {
    expect(names.filter((name) => name.startsWith("bad"))).toEqual([]);
  });

  test("a relative symlink that stays inside is kept", () => {
    expect(names).toContain("inside");
  });
});

suite("a symlink list longer than the output limit", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  let worktree = "";
  let detected = "";
  let remaining = -1;

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("many");
    writeFileSync(
      join(worktree, "many.ts"),
      [
        'import { symlinkSync } from "node:fs";',
        "for (let i = 0; i < 40000; i += 1) {",
        '  symlinkSync("/etc/passwd", String(i).padStart(8, "0") + "x".repeat(230));',
        "}",
        "",
      ].join("\n"),
    );
    const results = await runChecks(
      worktree,
      ["bun ./many.ts"],
      sandboxIn(lockDir, POOL),
      120_000,
    );
    detected = results.at(-1)?.output ?? "";
    remaining = readdirSync(worktree).filter((name) =>
      /^0000/.test(name),
    ).length;
  }, 240_000);

  afterAll(() => {
    fx.cleanup();
  });

  test("the failed check says the list was cut short", () => {
    expect(detected).toContain("cut short");
  });

  test("no symlink with an absolute content remains", () => {
    expect(remaining).toBe(0);
  });
});

suite("restoring the worktree of a run that never reached the scan", () => {
  const fx = makeRepo();
  const lockDir = join(fx.base, "slots");
  const uid = POOL[0] ?? 0;
  let worktree = "";
  let staleHome = "";
  let restored = false;
  let names: string[] = [];

  beforeAll(async () => {
    mkdirSync(WINDMILL_TMP_DIR, { recursive: true });
    worktree = fx.addWorktree("restore");
    staleHome = makeHome();
    const deps = defaultSandboxDeps(lockDir);
    await deps.slotRecords.write(0, {
      worktreeDir: worktree,
      homeDir: staleHome,
    });
    mustRun(["chown", "-R", `${String(uid)}:${String(uid)}`, worktree], "/");
    runAsUid(
      uid,
      "ln -s /etc/passwd evil; ln -s ../ok dotdot; touch ok",
      worktree,
    );
    restored = await restoreCheckOwnership(worktree, POOL, deps);
    names = readdirSync(worktree);
  }, 60_000);

  afterAll(() => {
    rmSync(staleHome, { recursive: true, force: true });
    fx.cleanup();
  });

  test("the worktree is restored", () => {
    expect(restored).toBe(true);
  });

  test("a symlink to an absolute path the run left is removed", () => {
    expect(names).not.toContain("evil");
  });

  test("a symlink with .. in its content the run left is removed", () => {
    expect(names).not.toContain("dotdot");
  });

  test("a regular file the run left is kept", () => {
    expect(names).toContain("ok");
  });
});
