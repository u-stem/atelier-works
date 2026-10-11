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
  createCheckSandbox,
  parsePasswdUid,
  resolveCheckUid,
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
const CHECK_UID = resolveCheckUid(process.env, readPasswd);

/** 検査の子孫として残したプロセスを探すため、実uidが検査用のプロセスのpidを返す。 */
function processesOfCheckUser(): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        const state = /^State:\s+(\S)/m.exec(status)?.[1];
        return uid === String(CHECK_UID) && state !== "Z";
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

    const sandbox = createCheckSandbox({ uid: CHECK_UID });
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

  test("the image's factory-check user has the uid the scripts resolve", () => {
    expect(parsePasswdUid(readPasswd(), "factory-check")).toBe(CHECK_UID);
  });

  test("the command runs as the check uid", () => {
    expect(probed("uid")).toBe(String(CHECK_UID));
  });

  test("the command's primary gid is not root", () => {
    expect(probed("gid")).toBe(String(CHECK_UID));
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
    expect(processesOfCheckUser()).toEqual([]);
  });

  test("root can run git in the worktree afterwards", () => {
    expect(runSync(["git", "status", "--porcelain"], worktree)).toBe(0);
  });

  test("the Windmill runtime directory is closed to other users", () => {
    expect(statSync(WINDMILL_TMP_DIR).mode & 0o077).toBe(0);
  });

  test("a command that outlives its timeout is stopped with its descendants", async () => {
    const sandbox = createCheckSandbox({ uid: CHECK_UID });
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
    expect([result?.timedOut, processesOfCheckUser()]).toEqual([true, []]);
  }, 60_000);
});
