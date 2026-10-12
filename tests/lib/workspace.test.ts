import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addDetachedWorktree,
  assertWorktreeGitPointer,
  boundedTimerMs,
  COMMITTED_TREE_CHANGED_REASON,
  type CommandResult,
  type CommandRunner,
  CommitBlockedError,
  commitAndPush,
  copyFileTo,
  createBunCommandRunner,
  createGtrWorktree,
  currentRemoteHeadSha,
  deleteLocalBranch,
  deleteRemoteBranch,
  dropRemovedDiffLines,
  ensureEmptyDir,
  ensureFactoryClone,
  ensureHeadOnBranch,
  ensureRepo,
  FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT,
  FIXED_GIT_CONFIG,
  factoryCloneLockPath,
  fetchPrHeadRef,
  formatGitleaksReport,
  type GitleaksConfigDir,
  isCappedOutput,
  isReviewWorktreeOf,
  type LockFs,
  listWorktrees,
  localGitEnv,
  mapDiffLineToFile,
  mergeBaseSha,
  OUTPUT_ABANDONED_NOTE,
  omittedMarker,
  parseNumstatTotals,
  pathExists,
  pruneWorktrees,
  pushNewBranch,
  RUNNER_MAX_STOP_OVERHEAD_MS,
  readAndVerifyWorktreeGitPointer,
  readDirEntries,
  readExactRef,
  readGitShowFile,
  readStreamAll,
  readStreamCapped,
  readTextFile,
  readWorktreeGitPointer,
  removeEmptyDir,
  removeIgnoredFiles,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  resolveDefaultBranchName,
  runCommand,
  runGitleaksOnWorktree,
  SpawnError,
  scannedTreeStopReasons,
  stagedTreeSha,
  verifyWorktreeGitdir,
  WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON,
  WorktreeGitPointerModifiedError,
  withCommitTrailers,
  withRepoLock,
  worktreeFingerprint,
  worktreeGitPointerMatches,
  writeTextFile,
} from "../../f/factory/lib/workspace.ts";
import { buildReviewWorktreeDir } from "../../f/factory/steps/pr_review_prepare.ts";
import { createFakeCommandRunner, fail, ok } from "./testSupport.ts";

describe("runCommand", () => {
  test("captures stdout of a trivial command", async () => {
    const result = await runCommand(["echo", "hello"]);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("propagates a non-zero exit code", async () => {
    const result = await runCommand(["sh", "-c", "exit 3"]);
    expect(result.exitCode).toBe(3);
  });

  test("pipes stdin through to the child process", async () => {
    const result = await runCommand(["cat"], { stdin: "piped input" });
    expect(result.stdout).toBe("piped input");
  });

  test("kills the process and reports timedOut after the timeout elapses", async () => {
    const result = await runCommand(["sleep", "5"], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
  });
});

// workerのイメージは`LD_LIBRARY_PATH=.`を持つ。rootの子プロセスに渡ると、cwdのworktreeに検査用のユーザーが置いた
// 共有ライブラリを読み込むので、子プロセスの環境は渡したものだけになることを確かめる。
describe("runCommand environment", () => {
  const saved = process.env.LD_LIBRARY_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = saved;
  });

  test("does not pass the runner's LD_LIBRARY_PATH to a child given an environment", async () => {
    process.env.LD_LIBRARY_PATH = ".";
    const result = await runCommand(["/usr/bin/env"], {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.stdout).not.toContain("LD_LIBRARY_PATH");
  });

  test("does not pass the runner's LD_LIBRARY_PATH to a child given no environment", async () => {
    process.env.LD_LIBRARY_PATH = ".";
    const result = await runCommand(["/usr/bin/env"]);
    expect(result.stdout).not.toContain("LD_LIBRARY_PATH");
  });
});

describe("boundedTimerMs", () => {
  test("keeps a value within the timer range", () => {
    expect(boundedTimerMs(1_500)).toBe(1_500);
  });

  test("keeps zero as an immediate timeout", () => {
    expect(boundedTimerMs(0)).toBe(0);
  });

  test("clamps a value that would overflow setTimeout", () => {
    expect(boundedTimerMs(2 ** 31)).toBe(2 ** 31 - 1);
  });

  test("raises a negative value to zero", () => {
    expect(boundedTimerMs(-5)).toBe(0);
  });

  test("throws for NaN", () => {
    expect(() => boundedTimerMs(Number.NaN)).toThrow();
  });

  test("throws for Infinity", () => {
    expect(() => boundedTimerMs(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("createBunCommandRunner timeoutMs validation", () => {
  test("rejects a non-finite timeoutMs before spawning", async () => {
    const run = createBunCommandRunner();
    await expect(run(["true"], { timeoutMs: Number.NaN })).rejects.toThrow();
  });
});

describe("createBunCommandRunner spawn failure", () => {
  const MISSING_COMMAND = "/nonexistent/factory-test-command";

  test("rejects with a SpawnError when the command cannot be started", async () => {
    const run = createBunCommandRunner();
    await expect(run([MISSING_COMMAND])).rejects.toBeInstanceOf(SpawnError);
  });

  test("keeps the error code of the failed spawn", async () => {
    const run = createBunCommandRunner();
    const error = await run([MISSING_COMMAND]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error instanceof SpawnError ? error.code : null).toBe("ENOENT");
  });

  test("keeps the original error as the cause", () => {
    const original = Object.assign(new Error("EAGAIN: try again"), {
      code: "EAGAIN",
    });
    expect(new SpawnError(original).cause).toBe(original);
  });

  test("keeps the original message", () => {
    const original = Object.assign(new Error("EAGAIN: try again"), {
      code: "EAGAIN",
    });
    expect(new SpawnError(original).message).toBe("EAGAIN: try again");
  });
});

describe("createBunCommandRunner SIGTERM -> SIGKILL escalation", () => {
  test("escalates to SIGKILL after killGraceMs when the process ignores SIGTERM", async () => {
    const run = createBunCommandRunner({ killGraceMs: 30 });
    // SIGTERMを無視させ、SIGKILLへの切り替えでしか終了しないようにする。
    const result = await run(["sh", "-c", "trap '' TERM; sleep 5"], {
      timeoutMs: 30,
    });
    expect(result.timedOut).toBe(true);
  });

  test("does not send SIGKILL when the process exits promptly on SIGTERM", async () => {
    const run = createBunCommandRunner({ killGraceMs: 5_000 });
    const start = Date.now();
    await run(["sleep", "5"], { timeoutMs: 30 });
    // SIGKILLまでの5秒の猶予が過ぎるのを待てば5秒を超える。
    // SIGTERMですぐ終了するプロセスなら、それより十分短く返る。
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("pathExists", () => {
  test("returns true for a file that exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-test-"));
    const file = join(dir, "present.txt");
    writeFileSync(file, "x");
    const exists = await pathExists(file);
    expect(exists).toBe(true);
  });

  test("returns false for a path that does not exist", async () => {
    const exists = await pathExists("/nonexistent/path/for/sure");
    expect(exists).toBe(false);
  });
});

function createInMemoryLockFs(): LockFs {
  const store = new Map<string, { content: string; mtimeMs: number }>();
  const clockMs = 0;
  return {
    tryCreate: async (lockPath, content) => {
      if (store.has(lockPath)) return false;
      store.set(lockPath, { content, mtimeMs: clockMs });
      return true;
    },
    read: async (lockPath) => store.get(lockPath)?.content ?? null,
    mtimeMs: async (lockPath) => store.get(lockPath)?.mtimeMs ?? null,
    remove: async (lockPath) => {
      store.delete(lockPath);
    },
  };
}

describe("withRepoLock", () => {
  test("acquires a free lock, runs fn, and releases it", async () => {
    const lockFs = createInMemoryLockFs();
    const result = await withRepoLock({
      lockPath: "/tmp/x.lock",
      lockFs,
      fn: async () => "done",
    });
    expect(result).toBe("done");
  });

  test("releases the lock after fn resolves", async () => {
    const lockFs = createInMemoryLockFs();
    await withRepoLock({
      lockPath: "/tmp/x.lock",
      lockFs,
      fn: async () => "done",
    });
    const stillHeld = await lockFs.read("/tmp/x.lock");
    expect(stillHeld).toBeNull();
  });

  test("writes a token in the lock content", async () => {
    const lockFs = createInMemoryLockFs();
    let capturedDuringHold: string | null = null;
    await withRepoLock({
      lockPath: "/tmp/x.lock",
      lockFs,
      fn: async () => {
        capturedDuringHold = await lockFs.read("/tmp/x.lock");
      },
    });
    const parsed: unknown = JSON.parse(capturedDuringHold ?? "{}");
    const token =
      typeof parsed === "object" && parsed !== null && "token" in parsed
        ? parsed.token
        : undefined;
    expect(typeof token).toBe("string");
  });

  test("times out when the lock stays held past maxWaitMs (fresh mtime, not stale)", async () => {
    let virtualNowMs = 0;
    const fakeNow = () => new Date(virtualNowMs);
    const fakeSleep = async (ms: number) => {
      virtualNowMs += ms;
    };
    const lockFs: LockFs = {
      tryCreate: async () => false,
      read: async () => JSON.stringify({ token: "someone-else" }),
      mtimeMs: async () => virtualNowMs, // 常に「更新したばかり」なので古いロックと判定されない
      remove: async () => {},
    };

    await expect(
      withRepoLock({
        lockPath: "/tmp/held.lock",
        lockFs,
        now: fakeNow,
        sleep: fakeSleep,
        staleMs: 10_000_000,
        maxWaitMs: 1_000,
        pollMs: 100,
        fn: async () => "unused",
      }),
    ).rejects.toThrow();
  });

  test("clears a lock whose mtime is older than staleMs and acquires it", async () => {
    const store = new Map<string, { content: string; mtimeMs: number }>([
      [
        "/tmp/stale.lock",
        { content: JSON.stringify({ token: "abandoned" }), mtimeMs: 0 },
      ],
    ]);
    const lockFs: LockFs = {
      tryCreate: async (lockPath, content) => {
        if (store.has(lockPath)) return false;
        store.set(lockPath, { content, mtimeMs: 1_000_000 });
        return true;
      },
      read: async (lockPath) => store.get(lockPath)?.content ?? null,
      mtimeMs: async (lockPath) => store.get(lockPath)?.mtimeMs ?? null,
      remove: async (lockPath) => {
        store.delete(lockPath);
      },
    };

    const result = await withRepoLock({
      lockPath: "/tmp/stale.lock",
      lockFs,
      now: () => new Date(1_000_000_000),
      staleMs: 1_000,
      fn: async () => "acquired",
    });
    expect(result).toBe("acquired");
  });

  test("does not delete the lock in finally if it was reclaimed by another holder while fn ran", async () => {
    const store = new Map<string, string>();
    let removeCalls = 0;
    const lockFs: LockFs = {
      tryCreate: async (lockPath, content) => {
        if (store.has(lockPath)) return false;
        store.set(lockPath, content);
        return true;
      },
      read: async (lockPath) => store.get(lockPath) ?? null,
      mtimeMs: async () => 0,
      remove: async (lockPath) => {
        removeCalls += 1;
        store.delete(lockPath);
      },
    };

    await withRepoLock({
      lockPath: "/tmp/reclaimed.lock",
      lockFs,
      fn: async () => {
        // `fn()`の実行中に、別のプロセスが別のトークンで
        // ロックを取り直した状況を再現する。
        store.set(
          "/tmp/reclaimed.lock",
          JSON.stringify({ token: "someone-else" }),
        );
      },
    });

    expect(removeCalls).toBe(0);
  });

  // コンテナの初回実行では、クローンより前の時点で
  // `ensureFactoryClone`のロックの親ディレクトリ(例: `/workspaces/factory/`)がまだ無い。
  // このとき実際の`tryCreate`の`open(path, "wx")`は`ENOENT`で失敗する。
  // ロック取得の再試行は「ロック済み」を表す`EEXIST`しか想定しておらず、
  // E2Eでは`pipeline_prepare`がこれで異常終了した。
  test("acquires the lock even when its parent directory doesn't exist yet (mkdir -p first)", async () => {
    let dirEnsured = false;
    const store = new Map<string, string>();
    const lockFs: LockFs = {
      tryCreate: async (lockPath, content) => {
        if (!dirEnsured) {
          const err = new Error(
            `ENOENT: no such file or directory, open '${lockPath}'`,
          );
          throw Object.assign(err, { code: "ENOENT" });
        }
        if (store.has(lockPath)) return false;
        store.set(lockPath, content);
        return true;
      },
      read: async (lockPath) => store.get(lockPath) ?? null,
      mtimeMs: async () => 0,
      remove: async (lockPath) => {
        store.delete(lockPath);
      },
      ensureLockDir: async () => {
        dirEnsured = true;
      },
    };

    const result = await withRepoLock({
      lockPath: "/workspaces/factory/atelier-works.lock",
      lockFs,
      fn: async () => "acquired",
    });
    expect(result).toBe("acquired");
  });
});

describe("ensureRepo", () => {
  test("clones with --no-checkout when the target dir does not exist", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    const result = await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      dir: "/workspaces/acme/widgets/main",
      action: "cloned",
    });
  });

  test("passes --no-checkout and the https clone URL", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    const cloneCall = fake.calls[1];
    expect(cloneCall?.argv).toContain("--no-checkout");
  });

  test("puts -- before the clone URL and dir", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[1]?.argv ?? [];
    const dashDashIndex = argv.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(-1);
  });

  test("disables hooks with core.hooksPath on the fetch call", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[1]?.argv.join(" ") ?? "";
    expect(argv).toContain("-c core.hooksPath=/dev/null");
  });

  test("clone (network op) carries GH_TOKEN in env", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-secret",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.options?.env?.GH_TOKEN).toBe("gh-secret");
  });

  test("fetches instead of cloning when the target dir already exists", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    const result = await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      dir: "/workspaces/acme/widgets/main",
      action: "fetched",
    });
  });

  test("throws with the trimmed, masked stderr when clone fails", async () => {
    const fake = createFakeCommandRunner([ok(), fail("permission denied")]);
    await expect(
      ensureRepo({
        run: fake.run,
        owner: "acme",
        repo: "widgets",
        ghToken: "gh-token",
        exists: async () => false,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/permission denied/);
  });

  test("rejects an owner containing a path separator before making any call", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      ensureRepo({
        run: fake.run,
        owner: "acme/../etc",
        repo: "widgets",
        ghToken: "gh-token",
        exists: async () => false,
      }),
    ).rejects.toThrow();
  });

  // `addDetachedWorktree`の`worktree add`に付ける`-c core.symlinks=false`と、
  // `git gtr new`に渡す`GIT_CONFIG_*`は、その1回の呼び出しにしか効かない。
  // 設定を本体のクローンのconfigに書き込まないと、同じリポジトリでの後続の操作
  // (`git status`、`add -A`、`commit`、特に再利用時の`reset --hard`)は
  // gitの既定の`core.symlinks=true`で動く。
  // 本体のconfigは、そのクローンのすべてのworktreeが共有する。
  test("persists core.symlinks=false into the main clone's config after cloning", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[2]?.argv ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["config", "core.symlinks", "false"]),
    );
  });

  test("persists core.symlinks=false into the main clone's config after fetching", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[2]?.argv ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["config", "core.symlinks", "false"]),
    );
  });
});

/** gitのargvにある`-c key=value`の`key=value`を、並んだ順に返す。 */
function commandLineConfig(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) =>
    arg === "-c" && argv[index + 1] !== undefined
      ? [argv[index + 1] ?? ""]
      : [],
  );
}

describe("git config isolation", () => {
  /** `ensureRepo`が、fetch(ネットワーク)と`git config`(ローカル)の順に実行したgitの呼び出しを返す。 */
  async function fetchAndConfigCalls() {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureRepo({
      run: fake.run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    return { network: fake.calls[1], local: fake.calls[2] };
  }

  test("local git does not read the global config", async () => {
    const { local } = await fetchAndConfigCalls();
    expect(local?.options?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  test("local git does not read the system config (GIT_CONFIG_NOSYSTEM)", async () => {
    const { local } = await fetchAndConfigCalls();
    expect(local?.options?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  test("local git does not read the system config (GIT_CONFIG_SYSTEM)", async () => {
    const { local } = await fetchAndConfigCalls();
    expect(local?.options?.env?.GIT_CONFIG_SYSTEM).toBe("/dev/null");
  });

  test("local git does not read the system attributes", async () => {
    const { local } = await fetchAndConfigCalls();
    expect(local?.options?.env?.GIT_ATTR_NOSYSTEM).toBe("1");
  });

  test("network git does not read the global config", async () => {
    const { network } = await fetchAndConfigCalls();
    expect(network?.options?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  test("network git does not read the system config", async () => {
    const { network } = await fetchAndConfigCalls();
    expect(network?.options?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  test("fixes exactly these config keys", () => {
    expect(FIXED_GIT_CONFIG.map(([key]) => key).sort()).toEqual([
      "commit.gpgsign",
      "core.askPass",
      "core.attributesFile",
      "core.excludesFile",
      "core.fsmonitor",
      "core.hooksPath",
      "core.symlinks",
      "credential.helper",
      "push.gpgSign",
    ]);
  });

  test.each([...FIXED_GIT_CONFIG])(
    "local git fixes %s=%s on the command line",
    async (key, value) => {
      const { local } = await fetchAndConfigCalls();
      expect(commandLineConfig(local?.argv ?? [])).toContain(`${key}=${value}`);
    },
  );

  test.each([...FIXED_GIT_CONFIG])(
    "network git fixes %s=%s on the command line",
    async (key, value) => {
      const { network } = await fetchAndConfigCalls();
      expect(commandLineConfig(network?.argv ?? [])).toContain(
        `${key}=${value}`,
      );
    },
  );

  test("network git adds the gh credential helper after the fixed empty one", async () => {
    const { network } = await fetchAndConfigCalls();
    const config = commandLineConfig(network?.argv ?? []);
    expect(config.slice(-2)).toEqual([
      "credential.helper=",
      "credential.helper=!gh auth git-credential",
    ]);
  });

  test("local git allows only https, over protocol.*.allow in the repo config", async () => {
    const { local } = await fetchAndConfigCalls();
    expect(local?.options?.env?.GIT_ALLOW_PROTOCOL).toBe("https");
  });

  test("network git allows only https, so GH_TOKEN never reaches another transport", async () => {
    const { network } = await fetchAndConfigCalls();
    expect(network?.options?.env?.GIT_ALLOW_PROTOCOL).toBe("https");
  });

  test("local git points TMPDIR at the given job directory", () => {
    const env = localGitEnv("/home/x", "/usr/bin", "/run/factory-tmp/fj-x");
    expect(env.TMPDIR).toBe("/run/factory-tmp/fj-x");
  });

  test("local git leaves TMPDIR unset outside a job", () => {
    const env = localGitEnv("/home/x", "/usr/bin");
    expect(env.TMPDIR).toBeUndefined();
  });

  test("keeps the global config off when HOME is unset", async () => {
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const fake = createFakeCommandRunner([ok("abc\n")]);
      await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
      expect(fake.calls[0]?.options?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });

  test("does not pass HOME when HOME is unset", async () => {
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const fake = createFakeCommandRunner([ok("abc\n")]);
      await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
      expect(fake.calls[0]?.options?.env).not.toHaveProperty("HOME");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });
});

describe("git config isolation (real git)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** 一時ディレクトリに空のリポジトリを作る。`HOME`は別の空のディレクトリにする。 */
  async function initRepo(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    const env = { PATH: process.env.PATH ?? "", HOME: root };
    const init = await runCommand(["git", "init", "-q", repo], { env });
    expect(init.exitCode).toBe(0);
    return { root, repo, home };
  }

  /**
   * `$HOME/.config/git/ignore`は設定ファイルではないので、`GIT_CONFIG_GLOBAL`では止まらない。
   * 読まれると、`git clean -fdX`が、リポジトリの`.gitignore`にないファイルを消す。
   */
  test("does not read the ignore file under HOME", async () => {
    const { repo, home } = await initRepo("git-isolation-ignore-");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), "*.cache\n");
    writeFileSync(join(repo, "work.cache"), "x");
    await removeIgnoredFiles({ run: runCommand, worktreeDir: repo, home });
    expect(existsSync(join(repo, "work.cache"))).toBe(true);
  });

  /**
   * 検査コマンドが`.git/config`に`protocol.ext.allow=always`と`ext::`のURLを書いても、
   * `GIT_ALLOW_PROTOCOL`が優先され、コマンドは実行されない。
   */
  test("does not run an ext:: remote even if the repo config allows it", async () => {
    const { root, repo, home } = await initRepo("git-isolation-ext-");
    const marker = join(root, "marker");
    const script = join(root, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    const config = (args: readonly string[]) =>
      runCommand(["git", "-C", repo, "config", ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: root },
      });
    await config(["protocol.ext.allow", "always"]);
    await config(["remote.origin.url", `ext::${script}`]);
    await fetchPrHeadRef(runCommand, repo, 1, "gh-token", home).catch(
      () => undefined,
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("factoryCloneLockPath", () => {
  test("is the sibling <dir>.lock file, not the worktree helpers' lock", () => {
    // 準備
    const dir = "/workspaces/factory/atelier-works";
    // 実行
    const lockPath = factoryCloneLockPath(dir);
    // 検証
    expect(lockPath).toBe("/workspaces/factory/atelier-works.lock");
  });
});

describe("ensureFactoryClone", () => {
  test("clones the repo URL when the clone dir does not exist", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const result = await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      dir: "/workspaces/factory/atelier-works",
      action: "cloned",
    });
  });

  test("clones with --branch <branch> --single-branch (factory_branch is required — no default)", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "release",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).toContain("--single-branch");
    expect(argv.indexOf("--branch") + 1).toBe(argv.indexOf("release"));
  });

  test("rejects an invalid branch name before spawning anything", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      ensureFactoryClone({
        run: fake.run,
        repoUrl: "https://github.com/acme/atelier-works.git",
        ghToken: "gh-token",
        branch: "-oops",
        exists: async () => false,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/invalid branch name/);
  });

  test("fetches then checks out -B the configured branch when the clone dir already exists", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    const result = await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      dir: "/workspaces/factory/atelier-works",
      action: "pulled",
    });
    expect(fake.calls[1]?.argv).toEqual(
      expect.arrayContaining(["fetch", "origin", "--", "main"]),
    );
    expect(fake.calls[4]?.argv).toEqual(
      expect.arrayContaining([
        "checkout",
        "-B",
        "main",
        "refs/remotes/origin/main",
      ]),
    );
  });

  test("runs FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT git commands when the clone dir already exists", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls).toHaveLength(FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT);
  });

  test("discards local modifications (reset --hard) between fetch and checkout -B", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[2]?.argv).toEqual(
      expect.arrayContaining(["reset", "--hard"]),
    );
  });

  test("checks out -B the *configured* branch even when the existing clone was left on a different one (a prior caller defaulting to main must not stick)", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "feat/factory-foundation",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.argv).toEqual(
      expect.arrayContaining([
        "fetch",
        "origin",
        "--",
        "feat/factory-foundation",
      ]),
    );
    expect(fake.calls[4]?.argv).toEqual(
      expect.arrayContaining([
        "checkout",
        "-B",
        "feat/factory-foundation",
        "refs/remotes/origin/feat/factory-foundation",
      ]),
    );
  });

  test("points origin at the configured repo URL before fetching, so a stale origin is never fetched", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv.slice(-5)).toEqual([
      "remote",
      "set-url",
      "origin",
      "--",
      "https://github.com/acme/atelier-works.git",
    ]);
  });

  test("does not fetch when pointing origin at the configured URL fails", async () => {
    const fake = createFakeCommandRunner([fail("No such remote")]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    }).catch(() => undefined);
    expect(fake.calls.some((call) => call.argv.includes("fetch"))).toBe(false);
  });

  test("does not touch origin when it clones", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls.some((call) => call.argv.includes("set-url"))).toBe(
      false,
    );
  });

  test("runs beforeUpdate while holding the lock", async () => {
    const lockFs = createInMemoryLockFs();
    let lockHeld = false;
    const fake = createFakeCommandRunner([ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => false,
      lockFs,
      beforeUpdate: async () => {
        lockHeld =
          (await lockFs.read("/workspaces/factory/atelier-works.lock")) !==
          null;
      },
    });
    expect(lockHeld).toBe(true);
  });

  test("runs no git command when beforeUpdate throws", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
      beforeUpdate: () => Promise.reject(new Error("not verified")),
    }).catch(() => undefined);
    expect(fake.calls).toEqual([]);
  });

  test("releases the lock when beforeUpdate throws", async () => {
    const lockFs = createInMemoryLockFs();
    await ensureFactoryClone({
      run: createFakeCommandRunner([]).run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs,
      beforeUpdate: () => Promise.reject(new Error("not verified")),
    }).catch(() => undefined);
    expect(await lockFs.read("/workspaces/factory/atelier-works.lock")).toBe(
      null,
    );
  });

  test("throws when the fetch fails", async () => {
    const fake = createFakeCommandRunner([ok(), fail("could not fetch")]);
    await expect(
      ensureFactoryClone({
        run: fake.run,
        repoUrl: "https://github.com/acme/atelier-works.git",
        ghToken: "gh-token",
        branch: "main",
        exists: async () => true,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow();
  });

  test("throws without checking out when the tracking ref does not exist", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      fail("not a valid ref"),
    ]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    }).catch(() => undefined);
    expect(fake.calls.some((call) => call.argv.includes("checkout"))).toBe(
      false,
    );
  });

  test("throws when the checkout fails", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      fail("could not checkout"),
    ]);
    await expect(
      ensureFactoryClone({
        run: fake.run,
        repoUrl: "https://github.com/acme/atelier-works.git",
        ghToken: "gh-token",
        branch: "main",
        exists: async () => true,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow();
  });

  test("acquires a lock scoped to the clone dir before pulling (security fix, devil-advocate: avoids .git/index.lock races between concurrent flows and poll_issues sharing the same self clone)", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(),
    ]);
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/workspaces/factory/atelier-works.lock")) !==
          null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await ensureFactoryClone({
      run: runAndCheck,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs,
    });
    expect(sawLockDuringRun).toBe(true);
  });
});

describe("addDetachedWorktree", () => {
  test("fetches the sha then adds a detached worktree", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    const result = await addDetachedWorktree({
      run: fake.run,
      repoDir: "/workspaces/acme/widgets/main",
      sha: "abc1234",
      dir: "/workspaces/acme/widgets/review-42-abc1234",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      dir: "/workspaces/acme/widgets/review-42-abc1234",
    });
  });

  test("the fetch call (network) carries GH_TOKEN but the worktree add call (local) does not", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    await addDetachedWorktree({
      run: fake.run,
      repoDir: "/repo",
      sha: "abc1234",
      dir: "/repo/wt",
      ghToken: "gh-secret",
      lockFs: createInMemoryLockFs(),
    });
    expect([
      fake.calls[0]?.options?.env?.GH_TOKEN,
      fake.calls[1]?.options?.env?.GH_TOKEN,
    ]).toEqual(["gh-secret", undefined]);
  });

  test("rejects a sha that isn't valid hex", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      addDetachedWorktree({
        run: fake.run,
        repoDir: "/repo",
        sha: "-not-a-sha",
        dir: "/repo/wt",
        ghToken: "gh-token",
      }),
    ).rejects.toThrow();
  });

  test("adds -c core.symlinks=false before the worktree add subcommand (security fix: don't check out a committed symlink)", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    await addDetachedWorktree({
      run: fake.run,
      repoDir: "/repo",
      sha: "abc1234",
      dir: "/repo/wt",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[1]?.argv ?? [];
    const symlinksIndex = argv.indexOf("core.symlinks=false");
    const worktreeIndex = argv.indexOf("worktree");
    expect(symlinksIndex).toBeGreaterThan(-1);
    expect(argv[symlinksIndex - 1]).toBe("-c");
    expect(symlinksIndex).toBeLessThan(worktreeIndex);
  });
});

// `/tmp/repo`に登録済みのworktree(`REAL_WORKTREE_PORCELAIN`)と、
// その`.git`ポインタの検査に使うファイルシステムの代用品。
// 正規のポインタは`verifyWorktreeGitdir`を通り、
// 向け先を変えたポインタは失敗する。
const REUSED_REPO = "/tmp/repo";
const REUSED_WT = "/tmp/repo-worktrees/contract-smoke-branch";
function pointerFsDeps(pointerOk: boolean): {
  readonly fs: {
    readonly readTextFile: (path: string) => Promise<string>;
    readonly realpath: (path: string) => Promise<string>;
    readonly removeDir: (path: string) => Promise<void>;
  };
  readonly removed: string[];
} {
  const removed: string[] = [];
  return {
    removed,
    fs: {
      readTextFile: async (path) => {
        if (path === `${REUSED_WT}/.git`) {
          return pointerOk
            ? `gitdir: ${REUSED_REPO}/.git/worktrees/contract-smoke-branch\n`
            : "gitdir: /evil/.git/worktrees/x\n";
        }
        if (path.endsWith("/gitdir")) return `${REUSED_WT}/.git\n`;
        throw new Error(`unexpected read: ${path}`);
      },
      realpath: async (path) => resolve(path),
      removeDir: async (path) => {
        removed.push(path);
      },
    },
  };
}

describe("removeWorktree", () => {
  // [0] `git worktree list`(ポインタの検査)、[1] remove、[2] prune。
  const verified = () =>
    createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN), ok(), ok()]);

  test("includes --force when requested", async () => {
    const fake = verified();
    await removeWorktree({
      run: fake.run,
      repoDir: REUSED_REPO,
      dir: REUSED_WT,
      force: true,
      lockFs: createInMemoryLockFs(),
      fs: pointerFsDeps(true).fs,
    });
    expect(fake.calls[1]?.argv).toContain("--force");
  });

  test("puts -- before the worktree dir", async () => {
    const fake = verified();
    await removeWorktree({
      run: fake.run,
      repoDir: REUSED_REPO,
      dir: REUSED_WT,
      lockFs: createInMemoryLockFs(),
      fs: pointerFsDeps(true).fs,
    });
    const argv = fake.calls[1]?.argv ?? [];
    expect(argv.at(-2)).toBe("--");
  });

  test("prunes after removing", async () => {
    const fake = verified();
    await removeWorktree({
      run: fake.run,
      repoDir: REUSED_REPO,
      dir: REUSED_WT,
      lockFs: createInMemoryLockFs(),
      fs: pointerFsDeps(true).fs,
    });
    expect(fake.calls[2]?.argv).toContain("prune");
  });

  test("is serialized under the same lock path ensureRepo would use for this repo", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = verified();
    // コマンド実行を包み、実行の途中でロックファイルがあるかを確かめる。
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/tmp/main.lock")) !== null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await removeWorktree({
      run: runAndCheck,
      repoDir: REUSED_REPO,
      dir: REUSED_WT,
      lockFs,
      fs: pointerFsDeps(true).fs,
    });
    expect(sawLockDuringRun).toBe(true);
  });

  describe("when the .git pointer fails verification", () => {
    // [0] list(ポインタの検査)、[1] list(代替の削除経路での安全確認)、[2] prune。
    const unverified = () =>
      createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
      ]);
    const remove = async (
      run: ReturnType<typeof unverified>["run"],
      deps = pointerFsDeps(false),
      repoDir = REUSED_REPO,
      dir = REUSED_WT,
    ) =>
      removeWorktree({
        run,
        repoDir,
        dir,
        force: true,
        lockFs: createInMemoryLockFs(),
        fs: deps.fs,
      });

    test("does not run git worktree remove", async () => {
      const fake = unverified();
      await remove(fake.run);
      expect(fake.calls.some((call) => call.argv.includes("remove"))).toBe(
        false,
      );
    });

    test("never runs git inside the worktree", async () => {
      const fake = unverified();
      await remove(fake.run);
      expect(fake.calls.some((call) => call.options?.cwd === REUSED_WT)).toBe(
        false,
      );
    });

    test("deletes the directory through the fs", async () => {
      const deps = pointerFsDeps(false);
      await remove(unverified().run, deps);
      expect(deps.removed).toEqual([REUSED_WT]);
    });

    test("prunes from repoDir", async () => {
      const fake = unverified();
      await remove(fake.run);
      expect(
        fake.calls.find((call) => call.argv.includes("prune"))?.options?.cwd,
      ).toBe(REUSED_REPO);
    });

    test("refuses a directory git worktree list does not report", async () => {
      await expect(
        remove(
          unverified().run,
          pointerFsDeps(false),
          REUSED_REPO,
          "/tmp/repo-worktrees/unknown",
        ),
      ).rejects.toThrow(/not a registered worktree/);
    });

    test("refuses a directory outside the repository's workspace dir", async () => {
      await expect(
        remove(unverified().run, pointerFsDeps(false), "/srv/checkout/repo"),
      ).rejects.toThrow(/outside/);
    });

    test("deletes nothing when it refuses", async () => {
      const deps = pointerFsDeps(false);
      await remove(unverified().run, deps, "/srv/checkout/repo").catch(
        () => {},
      );
      expect(deps.removed).toEqual([]);
    });
  });
});

describe("pruneWorktrees", () => {
  test("runs git worktree prune in repoDir", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await pruneWorktrees({
      run: fake.run,
      repoDir: "/repo/main",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv).toContain("prune");
    expect(fake.calls[0]?.options?.cwd).toBe("/repo/main");
  });

  test("throws when git worktree prune fails", async () => {
    const fake = createFakeCommandRunner([fail("not a git repository")]);
    await expect(
      pruneWorktrees({
        run: fake.run,
        repoDir: "/repo/main",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow();
  });

  test("is serialized under the same lock path other worktree operations use for this repo", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = createFakeCommandRunner([ok()]);
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/repo/main.lock")) !== null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await pruneWorktrees({ run: runAndCheck, repoDir: "/repo/main", lockFs });
    expect(sawLockDuringRun).toBe(true);
  });
});

// 再利用の経路で、追跡refの読み取りが返すsha。
const TRACKING_SHA = "c".repeat(40);

/**
 * `git worktree list --porcelain -z`の出力を組み立てる。
 * 各行をNULで終え、各レコードの後にもう1つNULを置く。
 */
function porcelainZ(records: readonly (readonly string[])[]): string {
  return records
    .map((lines) => `${lines.map((line) => `${line}\0`).join("")}\0`)
    .join("");
}

// 実際の`git worktree list --porcelain -z`の出力の形に合わせて組み立てたもの。
const REAL_WORKTREE_PORCELAIN = porcelainZ([
  [
    "worktree /tmp/repo",
    "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
    "branch refs/heads/main",
  ],
  [
    "worktree /tmp/repo-worktrees/contract-smoke-branch",
    "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
    "branch refs/heads/contract-smoke-branch",
  ],
]);

describe("listWorktrees", () => {
  test("parses a real captured `git worktree list --porcelain` sample", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    const entries = await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(entries).toEqual([
      {
        path: "/tmp/repo",
        headSha: "c4c85336fb74d3bc13cca578c870a39583722c58",
        branch: "main",
        bare: false,
        detached: false,
      },
      {
        path: "/tmp/repo-worktrees/contract-smoke-branch",
        headSha: "c4c85336fb74d3bc13cca578c870a39583722c58",
        branch: "contract-smoke-branch",
        bare: false,
        detached: false,
      },
    ]);
  });

  test("asks git for NUL-separated output", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(fake.calls[0]?.argv.slice(-4)).toEqual([
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
  });

  test("returns no entries for empty output", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    const entries = await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(entries).toEqual([]);
  });

  test("keeps a path that contains a newline as one path", async () => {
    const path = "/tmp/repo-worktrees/a\nb";
    const fake = createFakeCommandRunner([
      ok(porcelainZ([[`worktree ${path}`, "HEAD deadbeef", "detached"]])),
    ]);
    const entries = await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(entries.map((entry) => entry.path)).toEqual([path]);
  });

  test("does not read a line inside a path as an attribute", async () => {
    const path = "/tmp/wt\nbranch refs/heads/victim";
    const fake = createFakeCommandRunner([
      ok(porcelainZ([[`worktree ${path}`, "HEAD deadbeef", "detached"]])),
    ]);
    const entries = await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(entries.map((entry) => entry.branch)).toEqual([null]);
  });

  test("throws when the output ends before the last record is terminated", async () => {
    const complete = porcelainZ([
      ["worktree /repo", "HEAD deadbeef", "branch refs/heads/main"],
    ]);
    const fake = createFakeCommandRunner([ok(complete.slice(0, -1))]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/truncated/);
  });

  test("throws when the output ends in the middle of an attribute", async () => {
    const fake = createFakeCommandRunner([
      ok("worktree /repo\0HEAD deadbeef\0branch refs/hea"),
    ]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/truncated/);
  });

  test("throws when the output stops after an attribute with no record end", async () => {
    const fake = createFakeCommandRunner([
      ok("worktree /repo\0HEAD deadbeef\0"),
    ]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/truncated/);
  });

  test("throws when a record has no worktree line", async () => {
    const fake = createFakeCommandRunner([
      ok(porcelainZ([["HEAD deadbeef", "branch refs/heads/main"]])),
    ]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/unexpected 'git worktree list --porcelain -z' record/);
  });

  test("throws when the output was abandoned even if it ends at a complete record", async () => {
    const fake = createFakeCommandRunner([
      { ...ok(REAL_WORKTREE_PORCELAIN), outputAbandoned: true },
    ]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/output was abandoned/);
  });

  test("throws when a record is empty", async () => {
    const fake = createFakeCommandRunner([
      ok(`${porcelainZ([["worktree /repo", "bare"]])}\0`),
    ]);
    await expect(
      listWorktrees({ run: fake.run, repoDir: "/repo" }),
    ).rejects.toThrow(/empty record/);
  });

  test("parses bare and detached markers", async () => {
    const porcelain = porcelainZ([
      ["worktree /repo", "bare"],
      ["worktree /repo/wt", "HEAD deadbeef", "detached"],
    ]);
    const fake = createFakeCommandRunner([ok(porcelain)]);
    const entries = await listWorktrees({ run: fake.run, repoDir: "/repo" });
    expect(entries).toEqual([
      {
        path: "/repo",
        headSha: null,
        branch: null,
        bare: true,
        detached: false,
      },
      {
        path: "/repo/wt",
        headSha: "deadbeef",
        branch: null,
        bare: false,
        detached: true,
      },
    ]);
  });
});

describe("listWorktrees (real git)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** 実際のgitが、改行を含むパスのworktreeを1件として返すことを確かめる。 */
  test("reads a worktree whose path contains a newline as one entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "list-worktrees-"));
    roots.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const worktree = join(root, "wt\nbranch refs/heads/victim");
    mkdirSync(repo);
    mkdirSync(home);
    const git = async (cwd: string, args: readonly string[]) => {
      const result = await runCommand(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
    };
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    await git(repo, ["worktree", "add", "-q", "--detach", worktree]);
    const entries = await listWorktrees({
      run: runCommand,
      repoDir: repo,
      home,
    });
    expect(entries.map((entry) => entry.branch)).toEqual(["main", null]);
  });

  /**
   * HOMEのグローバル設定が、gitの実行に効かないことを確かめる。
   * `safe.bareRepository=explicit`はグローバル設定からだけ読まれ、
   * 暗黙に見つけたbareリポジトリでのgitを拒否するため、読まれたかどうかが結果に出る。
   */
  test("does not read the global config under HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "list-worktrees-global-"));
    roots.push(root);
    const bare = join(root, "bare.git");
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, ".gitconfig"),
      "[safe]\n\tbareRepository = explicit\n",
    );
    const init = await runCommand(["git", "init", "-q", "--bare", bare], {
      env: { PATH: process.env.PATH ?? "", HOME: root },
    });
    expect(init.exitCode).toBe(0);
    const entries = await listWorktrees({
      run: runCommand,
      repoDir: bare,
      home,
    });
    expect(entries).toHaveLength(1);
  });
});

/** 別のworktreeが`contract-smoke-branch`をcheckoutしている`git worktree list --porcelain -z`の出力。 */
const BRANCH_IN_ANOTHER_WORKTREE = porcelainZ([
  [
    "worktree /tmp/repo",
    "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
    "branch refs/heads/main",
  ],
  [
    `worktree ${REUSED_WT}`,
    "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
    "branch refs/heads/other",
  ],
  [
    "worktree /tmp/repo-worktrees/elsewhere",
    "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
    "branch refs/heads/contract-smoke-branch",
  ],
]);

/** プロセスが残っていないとみなす(何も止めなかった)`assertProcessesIdle`。 */
const idle = async (): Promise<boolean> => false;
/** `git gtr new`で作ったブランチの先頭。 */
const NEW_HEAD_SHA = "e".repeat(40);
/** 再利用するworktreeのHEADが対象のブランチを指しているときの`git symbolic-ref -q HEAD`の出力。 */
const HEAD_ON_REUSED_BRANCH = "refs/heads/contract-smoke-branch\n";

describe("createGtrWorktree", () => {
  test("reuses an existing worktree whose branch matches", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(REAL_WORKTREE_PORCELAIN),
      ok(REAL_WORKTREE_PORCELAIN),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(HEAD_ON_REUSED_BRANCH),
      ok(),
      ok(),
    ]);
    const result = await createGtrWorktree({
      run: fake.run,
      repoDir: REUSED_REPO,
      branch: "contract-smoke-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
      fs: pointerFsDeps(true).fs,
    });
    expect(result.hookStatus).toBe("reused");
  });

  test("does not call `git gtr new` when reusing", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(REAL_WORKTREE_PORCELAIN),
      ok(REAL_WORKTREE_PORCELAIN),
      ok(),
      ok(`${TRACKING_SHA}\n`),
      ok(HEAD_ON_REUSED_BRANCH),
      ok(),
      ok(),
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: REUSED_REPO,
      branch: "contract-smoke-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
      fs: pointerFsDeps(true).fs,
    });
    expect(fake.calls.some((call) => call.argv.includes("gtr"))).toBe(false);
  });

  // 前のラウンドでClaudeの実行がタイムアウトや中断で終わると、
  // 再利用するworktreeに余計な編集が残ることがある。
  // ブランチのリモートの最新状態に戻さないと、その編集が次のラウンドの
  // `git add -A`(`commitAndPush`)に紛れ込む。
  // 人がその間にブランチへ直接pushしていれば、古いローカル履歴のせいで
  // 次のpushがfast-forwardでなくなる。
  // そのため再利用するworktreeは、fetch、`reset --hard`、cleanで
  // `origin/<branch>`の状態に戻してから渡す。
  // `git gtr new`で作る新しいworktreeはリモートの最新状態から作るため、
  // この処理は要らない。
  describe("reuse path: fetch -> reset --hard -> clean (fixes stale-worktree bug)", () => {
    test("fetches origin/<branch> first", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      const argv = fake.calls[3]?.argv ?? [];
      expect(argv).toEqual(
        expect.arrayContaining([
          "fetch",
          "origin",
          "--",
          "contract-smoke-branch",
        ]),
      );
    });

    test("reads the tracking ref by its full name with show-ref after the fetch", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      expect(fake.calls[4]?.argv.slice(-5)).toEqual([
        "show-ref",
        "--verify",
        "--hash",
        "--",
        "refs/remotes/origin/contract-smoke-branch",
      ]);
    });

    test("does not reset when the tracking ref does not exist", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        fail("fatal: not a valid ref"),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      }).catch(() => undefined);
      expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
        false,
      );
    });

    test("then resets --hard to the sha read from the tracking ref", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      const argv = fake.calls[6]?.argv ?? [];
      expect(argv).toEqual(
        expect.arrayContaining(["reset", "--hard", TRACKING_SHA]),
      );
    });

    test("then cleans untracked files", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      const argv = fake.calls[7]?.argv ?? [];
      expect(argv).toEqual(expect.arrayContaining(["clean", "-fd"]));
    });

    test("does not put -- before the ref for reset --hard (same rev-parse-like exception as elsewhere)", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      const argv = fake.calls[6]?.argv ?? [];
      expect(argv).not.toContain("--");
    });

    test("resets and cleans in the worktree dir, not repoDir", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      expect([
        fake.calls[6]?.options?.cwd,
        fake.calls[7]?.options?.cwd,
      ]).toEqual([
        "/tmp/repo-worktrees/contract-smoke-branch",
        "/tmp/repo-worktrees/contract-smoke-branch",
      ]);
    });

    test("throws a masked error when the reset fails", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        fail("fatal: could not reset"),
      ]);
      await expect(
        createGtrWorktree({
          run: fake.run,
          repoDir: REUSED_REPO,
          branch: "contract-smoke-branch",
          ghToken: "gh-token",
          assertProcessesIdle: idle,
          lockFs: createInMemoryLockFs(),
          fs: pointerFsDeps(true).fs,
        }),
      ).rejects.toThrow(/reset --hard/);
    });
  });

  // `reset --hard`はHEADが指すブランチを動かす。生き残ったプロセスが別のブランチをcheckoutしていると、
  // そのブランチを動かし、対象のブランチは戻らない。
  describe("reuse path: HEAD must be on the branch before reset --hard", () => {
    // [0] prune、[1] list(再利用の検索)、[2] list(ポインタの検査)、[3] fetch、[4] show-ref(追跡ref)、[5] symbolic-ref、以降は`rest`。
    const reuse = (head: CommandResult, rest: readonly CommandResult[]) => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        head,
        ...rest,
      ]);
      const created = createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
      });
      return { fake, created };
    };
    // [6] list(他のworktreeの確認)、[7] checkout、[8] symbolic-ref(切り替えの後)、[9] reset、[10] clean。
    const switched = (): readonly CommandResult[] => [
      ok(REAL_WORKTREE_PORCELAIN),
      ok(),
      ok(HEAD_ON_REUSED_BRANCH),
      ok(),
      ok(),
    ];

    test("reads HEAD in the worktree after the fetch", async () => {
      const { fake, created } = reuse(ok(HEAD_ON_REUSED_BRANCH), [ok(), ok()]);
      await created;
      expect({
        argv: fake.calls[5]?.argv.slice(-3),
        cwd: fake.calls[5]?.options?.cwd,
      }).toEqual({ argv: ["symbolic-ref", "-q", "HEAD"], cwd: REUSED_WT });
    });

    test("reads HEAD without the network token", async () => {
      const { fake, created } = reuse(ok(HEAD_ON_REUSED_BRANCH), [ok(), ok()]);
      await created;
      expect(fake.calls[5]?.options?.env?.GH_TOKEN).toBeUndefined();
    });

    test("does not check out when HEAD is on the branch", async () => {
      const { fake, created } = reuse(ok(HEAD_ON_REUSED_BRANCH), [ok(), ok()]);
      await created;
      expect(fake.calls.some((call) => call.argv.includes("checkout"))).toBe(
        false,
      );
    });

    test("checks out the branch at the sha read from the tracking ref when HEAD is on another branch", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), switched());
      await created;
      expect({
        argv: fake.calls[7]?.argv.slice(-6),
        cwd: fake.calls[7]?.options?.cwd,
      }).toEqual({
        argv: [
          "checkout",
          "-f",
          "--no-track",
          "-B",
          "contract-smoke-branch",
          TRACKING_SHA,
        ],
        cwd: REUSED_WT,
      });
    });

    test("checks out the branch when HEAD is detached", async () => {
      const { fake, created } = reuse(fail("", 1), switched());
      await created;
      expect(fake.calls[7]?.argv).toContain("checkout");
    });

    test("still resets --hard after checking out the branch", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), switched());
      await created;
      expect(fake.calls[9]?.argv.slice(-3)).toEqual([
        "reset",
        "--hard",
        TRACKING_SHA,
      ]);
    });

    test("throws when HEAD cannot be read", async () => {
      const { created } = reuse(fail("fatal: not a git repository", 128), []);
      await expect(created).rejects.toThrow(/symbolic-ref HEAD failed/);
    });

    test("does not reset when HEAD cannot be read", async () => {
      const { fake, created } = reuse(
        fail("fatal: not a git repository", 128),
        [],
      );
      await created.catch(() => undefined);
      expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
        false,
      );
    });

    test("throws when the checkout fails", async () => {
      const { created } = reuse(ok("refs/heads/other\n"), [
        ok(REAL_WORKTREE_PORCELAIN),
        fail("fatal: 'contract-smoke-branch' is already used by worktree"),
      ]);
      await expect(created).rejects.toThrow(/checkout -f -B/);
    });

    test("does not reset when the checkout fails", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), [
        ok(REAL_WORKTREE_PORCELAIN),
        fail("fatal: 'contract-smoke-branch' is already used by worktree"),
      ]);
      await created.catch(() => undefined);
      expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
        false,
      );
    });

    test("throws when HEAD is still elsewhere after the checkout", async () => {
      const { created } = reuse(ok("refs/heads/other\n"), [
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok("refs/heads/other\n"),
      ]);
      await expect(created).rejects.toThrow(
        /HEAD is not refs\/heads\/contract-smoke-branch/,
      );
    });

    test("lists the worktrees from the worktree dir before the checkout", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), switched());
      await created;
      expect({
        argv: fake.calls[6]?.argv.slice(-4),
        cwd: fake.calls[6]?.options?.cwd,
      }).toEqual({
        argv: ["worktree", "list", "--porcelain", "-z"],
        cwd: REUSED_WT,
      });
    });

    test("throws when another worktree has the branch checked out", async () => {
      const { created } = reuse(ok("refs/heads/other\n"), [
        ok(BRANCH_IN_ANOTHER_WORKTREE),
      ]);
      await expect(created).rejects.toThrow(
        /branch contract-smoke-branch is checked out in another worktree \/tmp\/repo-worktrees\/elsewhere \(gtr worktree reuse\)/,
      );
    });

    test("does not check out when another worktree has the branch checked out", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), [
        ok(BRANCH_IN_ANOTHER_WORKTREE),
      ]);
      await created.catch(() => undefined);
      expect(fake.calls.some((call) => call.argv.includes("checkout"))).toBe(
        false,
      );
    });

    test("throws when the worktree list cannot be read", async () => {
      const { created } = reuse(ok("refs/heads/other\n"), [
        fail("fatal: not a git repository", 128),
      ]);
      await expect(created).rejects.toThrow(/git worktree list failed/);
    });

    test("does not check out or reset when the worktree list cannot be read", async () => {
      const { fake, created } = reuse(ok("refs/heads/other\n"), [
        fail("fatal: not a git repository", 128),
      ]);
      await created.catch(() => undefined);
      expect(
        fake.calls.some(
          (call) =>
            call.argv.includes("checkout") || call.argv.includes("reset"),
        ),
      ).toBe(false);
    });
  });

  describe("reuse path when the .git pointer fails verification", () => {
    const gtrPorcelain = `path\t${REUSED_WT}\nbranch\tcontract-smoke-branch\nhook_status\tnone\n`;
    // [0] prune(一覧の前)、[1] list(再利用の検索)、[2] list(ポインタの検査)、
    // [3] list(代替の削除経路での安全確認)、[4] prune、[5] gtr new。
    const recreate = async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(gtrPorcelain),
        ok(`${NEW_HEAD_SHA}\n`),
        ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
      ]);
      const deps = pointerFsDeps(false);
      const result = await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
        fs: deps.fs,
      });
      return { fake, deps, result };
    };

    test("never runs git inside the reused worktree", async () => {
      const { fake } = await recreate();
      expect(fake.calls.some((call) => call.options?.cwd === REUSED_WT)).toBe(
        false,
      );
    });

    test("deletes the worktree directory through the fs", async () => {
      const { deps } = await recreate();
      expect(deps.removed).toEqual([REUSED_WT]);
    });

    test("prunes from repoDir", async () => {
      const { fake } = await recreate();
      expect(
        fake.calls.findLast((call) => call.argv.includes("prune"))?.options
          ?.cwd,
      ).toBe(REUSED_REPO);
    });

    test("recreates the worktree with git gtr new", async () => {
      const { fake } = await recreate();
      expect(fake.calls.some((call) => call.argv.includes("gtr"))).toBe(true);
    });

    test("returns the recreated worktree", async () => {
      const { result } = await recreate();
      expect(result.hookStatus).toBe("none");
    });
  });

  test("parses a real captured `git gtr new --porcelain` sample when creating", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok(gtrPorcelain),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
    ]);
    const result = await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      path: "/tmp/repo-worktrees/new-branch",
      branch: "new-branch",
      hookStatus: "none",
    });
  });

  test("parses a `git gtr new --porcelain` output without a hook_status line", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok("path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\n"),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`),
    ]);
    const result = await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      path: "/tmp/repo-worktrees/new-branch",
      branch: "new-branch",
      hookStatus: "unknown",
    });
  });

  // 親ディレクトリごと消えたworktreeが一覧に残っていると、ロックファイルのパスを作れず毎回失敗するため。
  test("prunes stale worktree entries before listing", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok(gtrPorcelain),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    expect([
      fake.calls[0]?.argv.slice(-2),
      fake.calls[0]?.options?.cwd,
    ]).toEqual([["worktree", "prune"], "/repo"]);
  });

  test("throws when the prune before listing fails", async () => {
    const fake = createFakeCommandRunner([fail("fatal: prune")]);
    await expect(
      createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "new-branch",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/git worktree prune failed/);
  });

  test("rejects a branch name starting with a dash", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "-evil",
        ghToken: "gh-token",
        assertProcessesIdle: idle,
      }),
    ).rejects.toThrow();
  });

  test("runs git gtr new with --no-hooks so no hook runs in a tree gtr may have created at a wrong commit", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tdisabled\n";
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok(gtrPorcelain),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`),
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[2]?.argv.slice(-6)).toEqual([
      "gtr",
      "new",
      "new-branch",
      "--porcelain",
      "--yes",
      "--no-hooks",
    ]);
  });

  test("passes core.symlinks=false to git gtr new with -c, which reaches gtr's child gits through the environment", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok(gtrPorcelain),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[2]?.argv ?? [];
    expect(argv.slice(0, argv.indexOf("gtr")).join(" ")).toContain(
      "-c core.symlinks=false",
    );
  });

  test("git gtr new does not read the global config either", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([
      ok(),
      ok(""),
      ok(gtrPorcelain),
      ok(`${NEW_HEAD_SHA}\n`),
      ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      assertProcessesIdle: idle,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[2]?.options?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  describe("processes left by an earlier run", () => {
    test("checks a reused worktree right after listing worktrees", async () => {
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      const checked: string[] = [];
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
        assertProcessesIdle: async (dir) => {
          checked.push(`${dir}@${String(fake.calls.length)}`);
          return false;
        },
      });
      expect(checked).toEqual([`${REUSED_WT}@2`]);
    });

    test("does not reset a worktree that is still in use", async () => {
      // 3番目の応答でポインタの検証が通るので、確かめが無ければreset(5番目の呼び出し)まで進む。
      const fake = createFakeCommandRunner([
        ok(),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(`${TRACKING_SHA}\n`),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: REUSED_REPO,
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
        fs: pointerFsDeps(true).fs,
        assertProcessesIdle: async () => {
          throw new Error("busy");
        },
      }).catch(() => undefined);
      expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
        false,
      );
    });

    test("checks a newly created worktree", async () => {
      const gtrPorcelain =
        "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
      const fake = createFakeCommandRunner([
        ok(),
        ok(""),
        ok(gtrPorcelain),
        ok(`${NEW_HEAD_SHA}\n`),
        ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
      ]);
      const checked: string[] = [];
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "new-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
        assertProcessesIdle: async (dir) => {
          checked.push(dir);
          return false;
        },
      });
      expect(checked).toEqual(["/tmp/repo-worktrees/new-branch"]);
    });

    test("rejects when a newly created worktree is still in use", async () => {
      const gtrPorcelain =
        "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
      const fake = createFakeCommandRunner([
        ok(),
        ok(""),
        ok(gtrPorcelain),
        ok(`${NEW_HEAD_SHA}\n`),
        ok(`${NEW_HEAD_SHA}\n`), // refs/remotes/origin/<branch>
      ]);
      const created = createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "new-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
        assertProcessesIdle: async () => {
          throw new Error("busy");
        },
      });
      await expect(created).rejects.toThrow("busy");
    });

    describe("a newly created worktree whose leftover processes were stopped", () => {
      const CREATED_SHA = "d".repeat(40);
      const gtrNew = `path\t${REUSED_WT}\nbranch\tcontract-smoke-branch\nhook_status\tnone\n`;
      // [0] prune、[1] list(再利用の検索)、[2] gtr new、[3] rev-parse(作った時点の先頭)、
      // [4] show-ref(追跡ref)、[5] list(ポインタの検査)、[6] symbolic-ref、[7] reset、[8] clean。
      const responses = () => [
        ok(),
        ok(""),
        ok(gtrNew),
        ok(`${CREATED_SHA}\n`),
        ok(`${CREATED_SHA}\n`),
        ok(REAL_WORKTREE_PORCELAIN),
        ok(HEAD_ON_REUSED_BRANCH),
        ok(),
        ok(),
      ];
      const create = (
        fake: ReturnType<typeof createFakeCommandRunner>,
        stopped: boolean,
        pointerOk = true,
      ) =>
        createGtrWorktree({
          run: fake.run,
          repoDir: REUSED_REPO,
          branch: "contract-smoke-branch",
          ghToken: "gh-token",
          lockFs: createInMemoryLockFs(),
          fs: pointerFsDeps(pointerOk).fs,
          assertProcessesIdle: async () => stopped,
        });

      test("records the branch head in the main clone", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, true);
        expect({
          argv: fake.calls[3]?.argv.slice(-5),
          cwd: fake.calls[3]?.options?.cwd,
        }).toEqual({
          argv: [
            "show-ref",
            "--verify",
            "--hash",
            "--",
            "refs/heads/contract-smoke-branch",
          ],
          cwd: REUSED_REPO,
        });
      });

      test("checks processes right after recording the branch head", async () => {
        const fake = createFakeCommandRunner(responses());
        const checkedAt: number[] = [];
        await createGtrWorktree({
          run: fake.run,
          repoDir: REUSED_REPO,
          branch: "contract-smoke-branch",
          ghToken: "gh-token",
          lockFs: createInMemoryLockFs(),
          fs: pointerFsDeps(true).fs,
          assertProcessesIdle: async () => {
            checkedAt.push(fake.calls.length);
            return false;
          },
        });
        expect(checkedAt).toEqual([4]);
      });

      test("resets the worktree to the recorded commit", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, true);
        expect({
          argv: fake.calls[7]?.argv.slice(-3),
          cwd: fake.calls[7]?.options?.cwd,
        }).toEqual({
          argv: ["reset", "--hard", CREATED_SHA],
          cwd: REUSED_WT,
        });
      });

      test("then cleans untracked files", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, true);
        expect(fake.calls[8]?.argv.slice(-2)).toEqual(["clean", "-fd"]);
      });

      test("reads HEAD in the worktree before the reset", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, true);
        expect({
          argv: fake.calls[6]?.argv.slice(-3),
          cwd: fake.calls[6]?.options?.cwd,
        }).toEqual({ argv: ["symbolic-ref", "-q", "HEAD"], cwd: REUSED_WT });
      });

      test("checks out the branch at the recorded commit when HEAD moved to another branch", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 6),
          ok("refs/heads/other\n"),
          ok(REAL_WORKTREE_PORCELAIN),
          ok(),
          ok(HEAD_ON_REUSED_BRANCH),
          ok(),
          ok(),
        ]);
        await create(fake, true);
        expect(fake.calls[8]?.argv.slice(-6)).toEqual([
          "checkout",
          "-f",
          "--no-track",
          "-B",
          "contract-smoke-branch",
          CREATED_SHA,
        ]);
      });

      const anotherWorktreeHasBranch = () =>
        createFakeCommandRunner([
          ...responses().slice(0, 6),
          ok("refs/heads/other\n"),
          ok(BRANCH_IN_ANOTHER_WORKTREE),
        ]);

      test("throws when another worktree has the branch checked out", async () => {
        const fake = anotherWorktreeHasBranch();
        await expect(create(fake, true)).rejects.toThrow(
          /checked out in another worktree \/tmp\/repo-worktrees\/elsewhere \(gtr new restore\)/,
        );
      });

      test("does not check out or reset when another worktree has the branch checked out", async () => {
        const fake = anotherWorktreeHasBranch();
        await create(fake, true).catch(() => undefined);
        expect(
          fake.calls.some(
            (call) =>
              call.argv.includes("checkout") || call.argv.includes("reset"),
          ),
        ).toBe(false);
      });

      test("does not reset when HEAD cannot be read", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 6),
          fail("fatal: not a git repository", 128),
        ]);
        await create(fake, true).catch(() => undefined);
        expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
          false,
        );
      });

      test("verifies the .git pointer before resetting", async () => {
        const fake = createFakeCommandRunner(responses());
        await expect(create(fake, true, false)).rejects.toThrow(
          /does not point under/,
        );
      });

      test("does not reset a worktree whose .git pointer fails verification", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, true, false).catch(() => undefined);
        expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
          false,
        );
      });

      test("does not reset when nothing was stopped", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, false);
        expect(fake.calls.some((call) => call.argv.includes("reset"))).toBe(
          false,
        );
      });

      test("throws when the reset fails", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 7),
          fail("fatal: could not reset"),
        ]);
        await expect(create(fake, true)).rejects.toThrow(/reset --hard/);
      });

      test("throws when the clean fails", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 8),
          fail("fatal: could not clean"),
        ]);
        await expect(create(fake, true)).rejects.toThrow(/clean -fd/);
      });

      test("reads the tracking ref by its full name after recording the branch head", async () => {
        const fake = createFakeCommandRunner(responses());
        await create(fake, false);
        expect(fake.calls[4]?.argv.slice(-5)).toEqual([
          "show-ref",
          "--verify",
          "--hash",
          "--",
          "refs/remotes/origin/contract-smoke-branch",
        ]);
      });

      test("resets to the tracking ref when gtr created the branch elsewhere", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          ok(`${TRACKING_SHA}\n`),
          ...responses().slice(5),
        ]);
        await create(fake, false);
        expect(fake.calls[7]?.argv.slice(-3)).toEqual([
          "reset",
          "--hard",
          TRACKING_SHA,
        ]);
      });

      test("checks out the branch at the tracking sha when gtr created it elsewhere and HEAD moved", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          ok(`${TRACKING_SHA}\n`),
          ...responses().slice(5, 6),
          ok("refs/heads/other\n"),
          ok(REAL_WORKTREE_PORCELAIN),
          ok(),
          ok(HEAD_ON_REUSED_BRANCH),
          ok(),
          ok(),
        ]);
        await create(fake, false);
        expect(fake.calls[8]?.argv.slice(-6)).toEqual([
          "checkout",
          "-f",
          "--no-track",
          "-B",
          "contract-smoke-branch",
          TRACKING_SHA,
        ]);
      });

      test("falls back to refs/remotes/origin/HEAD when the branch is not on the remote", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          fail(
            "fatal: 'refs/remotes/origin/contract-smoke-branch' - not a valid ref",
            128,
          ),
          ok(`${TRACKING_SHA}\n`),
          ...responses().slice(5),
        ]);
        await create(fake, false);
        expect(fake.calls[5]?.argv.slice(-5)).toEqual([
          "show-ref",
          "--verify",
          "--hash",
          "--",
          "refs/remotes/origin/HEAD",
        ]);
      });

      test("resets to the default branch head when the branch is not on the remote and gtr branched elsewhere", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          fail(
            "fatal: 'refs/remotes/origin/contract-smoke-branch' - not a valid ref",
            128,
          ),
          ok(`${TRACKING_SHA}\n`),
          ...responses().slice(5),
        ]);
        await create(fake, false);
        expect(fake.calls[8]?.argv.slice(-3)).toEqual([
          "reset",
          "--hard",
          TRACKING_SHA,
        ]);
      });

      test("throws when neither the tracking ref nor refs/remotes/origin/HEAD exists", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          fail("fatal: not a valid ref", 128),
          fail("fatal: not a valid ref", 128),
        ]);
        await expect(create(fake, false)).rejects.toThrow(
          /refs\/remotes\/origin\/HEAD does not exist/,
        );
      });

      test("throws when the branch does not exist after gtr new", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 3),
          fail(
            "fatal: 'refs/heads/contract-smoke-branch' - not a valid ref",
            128,
          ),
        ]);
        await expect(create(fake, true)).rejects.toThrow(
          /refs\/heads\/contract-smoke-branch does not exist/,
        );
      });

      test("cleans ignored files too when gtr created the branch elsewhere", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 4),
          ok(`${TRACKING_SHA}\n`),
          ...responses().slice(5),
        ]);
        await create(fake, false);
        expect(fake.calls[8]?.argv.slice(-2)).toEqual(["clean", "-fdx"]);
      });

      test("throws when the branch head cannot be read", async () => {
        const fake = createFakeCommandRunner([
          ...responses().slice(0, 3),
          fail("fatal: Needed a single revision"),
        ]);
        await expect(create(fake, true)).rejects.toThrow(/show-ref/);
      });
    });
  });
});

describe("ensureHeadOnBranch (real git)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  type Fixture = {
    readonly worktree: string;
    readonly home: string;
    readonly mainSha: string;
    readonly run: CommandRunner;
    readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
  };

  /**
   * `main`・`target`・`other`のブランチを持つリポジトリと、`target`をcheckoutしたworktreeを作る。
   * 生き残りがworktreeで`other`へ切り替えてコミットした状態にする。
   * `HOME`を一時ディレクトリに向け、システムの設定も読ませないので、利用者のgitの設定に左右されない。
   */
  async function setUp(): Promise<Fixture> {
    const root = mkdtempSync(join(tmpdir(), "ensure-head-on-branch-"));
    roots.push(root);
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    const run: CommandRunner = (argv, options) =>
      runCommand(argv, {
        ...options,
        env: {
          ...options?.env,
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    const git = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await run(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    await git(repo, ["branch", "target"]);
    await git(repo, ["branch", "other"]);
    await git(repo, ["worktree", "add", "-q", worktree, "target"]);
    await git(worktree, ["checkout", "-q", "other"]);
    await git(worktree, ["commit", "-q", "--allow-empty", "-m", "left"]);
    return {
      worktree,
      home,
      mainSha: await git(repo, ["rev-parse", "main"]),
      run,
      git,
    };
  }

  const ensure = (fixture: Fixture, ref: string) =>
    ensureHeadOnBranch({
      run: fixture.run,
      dir: fixture.worktree,
      branch: "target",
      ref,
      context: "test",
      home: fixture.home,
    });

  test("does not move the branch HEAD was on", async () => {
    const fixture = await setUp();
    const before = await fixture.git(fixture.worktree, ["rev-parse", "other"]);
    await ensure(fixture, fixture.mainSha);
    expect(await fixture.git(fixture.worktree, ["rev-parse", "other"])).toBe(
      before,
    );
  });

  test("moves a detached HEAD onto the branch", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.worktree, ["checkout", "-q", "--detach"]);
    await ensure(fixture, fixture.mainSha);
    expect(await fixture.git(fixture.worktree, ["symbolic-ref", "HEAD"])).toBe(
      "refs/heads/target",
    );
  });

  test("does not record an upstream when switching to origin/<branch>", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.worktree, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    await fixture.git(fixture.worktree, [
      "update-ref",
      "refs/remotes/origin/target",
      fixture.mainSha,
    ]);
    await ensure(fixture, "origin/target");
    const merge = await fixture.run(
      ["git", "config", "--get", "branch.target.merge"],
      { cwd: fixture.worktree },
    );
    expect(merge.stdout).toBe("");
  });

  // 対象のブランチを別のworktreeに持たせ、`dir`のHEADは別の場所に置く。
  async function checkOutBranchElsewhere(fixture: Fixture): Promise<void> {
    await fixture.git(fixture.worktree, ["checkout", "-q", "--detach"]);
    await fixture.git(fixture.worktree, [
      "worktree",
      "add",
      "-q",
      `${fixture.worktree}-2`,
      "target",
    ]);
  }

  // gitの版に依らず、自前の確認で失敗する。fixtureの環境は`LANG`を渡さないので、gitの文言は英語になる。
  test("fails when the branch is checked out in another worktree", async () => {
    const fixture = await setUp();
    await checkOutBranchElsewhere(fixture);
    await expect(ensure(fixture, fixture.mainSha)).rejects.toThrow(
      /branch target is checked out in another worktree .*wt-2 \(test\)/,
    );
  });

  test("does not move the branch when it is checked out in another worktree", async () => {
    const fixture = await setUp();
    await checkOutBranchElsewhere(fixture);
    const before = await fixture.git(fixture.worktree, ["rev-parse", "target"]);
    // `other`は`target`と別のコミットを指すので、付け替えられれば位置が動く。
    const moved = await fixture.git(fixture.worktree, ["rev-parse", "other"]);
    await ensure(fixture, moved).catch(() => undefined);
    expect(await fixture.git(fixture.worktree, ["rev-parse", "target"])).toBe(
      before,
    );
  });

  test("keeps HEAD detached when the branch is checked out in another worktree", async () => {
    const fixture = await setUp();
    await checkOutBranchElsewhere(fixture);
    await ensure(fixture, fixture.mainSha).catch(() => undefined);
    const head = await fixture.run(["git", "symbolic-ref", "-q", "HEAD"], {
      cwd: fixture.worktree,
    });
    expect(head.exitCode).toBe(1);
  });
});

describe("ensureHeadOnBranch (fake git)", () => {
  const DIR = "/tmp/repo-worktrees/target";
  const listing = (...entries: readonly (readonly [string, string])[]) =>
    porcelainZ(
      entries.map(([path, branch]) => [
        `worktree ${path}`,
        "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
        `branch refs/heads/${branch}`,
      ]),
    );
  const ensureWith = (
    responses: readonly CommandResult[],
    realpathOf: (path: string) => Promise<string>,
  ) => {
    const fake = createFakeCommandRunner(responses);
    const done = ensureHeadOnBranch({
      run: fake.run,
      dir: DIR,
      branch: "target",
      ref: "origin/target",
      context: "test",
      realpath: realpathOf,
    });
    return { fake, done };
  };

  // HEADを読んだ後、一覧を取るまでの間に生き残りがdirのHEADを対象のブランチへ移した状況を模す。
  // 一覧ではdir自身が別のパスで対象のブランチに載るので、自分自身として除かれる。
  test("does not treat the dir itself as another worktree when it is listed by a different path", async () => {
    const { done } = ensureWith(
      [
        ok("refs/heads/other\n"),
        ok(listing(["/link/target", "target"])),
        ok(),
        ok("refs/heads/target\n"),
      ],
      async (path) => (path === "/link/target" ? DIR : path),
    );
    await expect(done).resolves.toBeUndefined();
  });

  test("does not list the worktrees when HEAD is already on the branch", async () => {
    const { fake, done } = ensureWith(
      [ok("refs/heads/target\n")],
      async (path) => path,
    );
    await done;
    expect(fake.calls.length).toBe(1);
  });

  const entry = (path: string, ...lines: readonly string[]) =>
    porcelainZ([
      [
        `worktree ${path}`,
        "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
        ...lines,
      ],
    ]);
  const switchesWith = (listed: string) =>
    ensureWith(
      [ok("refs/heads/other\n"), ok(listed), ok(), ok("refs/heads/target\n")],
      async (path) => path,
    ).done;

  test("does not block on a detached worktree in the list", async () => {
    await expect(
      switchesWith(entry("/elsewhere/detached", "detached")),
    ).resolves.toBeUndefined();
  });

  test("does not block on a bare entry in the list", async () => {
    await expect(
      switchesWith(porcelainZ([["worktree /elsewhere/bare", "bare"]])),
    ).resolves.toBeUndefined();
  });

  test("does not block on a prunable worktree of another branch", async () => {
    await expect(
      switchesWith(
        entry(
          "/elsewhere/gone",
          "branch refs/heads/feature",
          "prunable gitdir file points to non-existent location",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  test("proceeds to the checkout when the dir itself is missing from the list", async () => {
    const { fake, done } = ensureWith(
      [
        ok("refs/heads/other\n"),
        ok(entry("/tmp/repo", "branch refs/heads/main")),
        ok(),
        ok("refs/heads/target\n"),
      ],
      async (path) => path,
    );
    await done;
    expect(fake.calls[2]?.argv).toContain("checkout");
  });

  test("compares paths as given when realpath fails", async () => {
    const { done } = ensureWith(
      [ok("refs/heads/other\n"), ok(listing(["/elsewhere/target", "target"]))],
      async () => {
        throw new Error("ENOENT");
      },
    );
    await expect(done).rejects.toThrow(/checked out in another worktree/);
  });
});

describe("verifyWorktreeGitdir", () => {
  const WT = "/tmp/repo-worktrees/contract-smoke-branch";
  const GITDIR = "/tmp/repo/.git/worktrees/contract-smoke-branch";
  // `realpath`の代用品。本物と同じく`..`を正規化する
  // (ここではシンボリックリンクは無い)。
  const normalize = async (path: string): Promise<string> => resolve(path);
  function files(
    pointer: string,
    backPointer = `${WT}/.git\n`,
  ): (path: string) => Promise<string> {
    return async (path) => {
      if (path === `${WT}/.git`) return pointer;
      if (path.endsWith("/gitdir")) return backPointer;
      throw new Error(`unexpected read: ${path}`);
    };
  }

  test("passes when the dir is registered and .git points under the repo's worktrees dir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: files(`gitdir: ${GITDIR}\n`),
        realpath: normalize,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws when the dir is not a registered worktree of repoDir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: "/tmp/not-a-worktree",
        readTextFile: async () =>
          "gitdir: /tmp/repo/.git/worktrees/not-a-worktree\n",
        realpath: normalize,
      }),
    ).rejects.toThrow(/not registered/);
  });

  test("throws when .git points outside the expected repo's worktrees dir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: files(
          "gitdir: /somewhere/else/.git/worktrees/contract-smoke-branch\n",
        ),
        realpath: normalize,
      }),
    ).rejects.toThrow(/does not point under/);
  });

  test("rejects a gitdir that climbs out of the worktrees dir with ..", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: files(
          "gitdir: /tmp/repo/.git/worktrees/../../../evil\n",
          "/tmp/evil/.git\n",
        ),
        realpath: normalize,
      }),
    ).rejects.toThrow(/does not point under/);
  });

  test("rejects a gitdir nested below a worktree's own admin dir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: files(`gitdir: ${GITDIR}/nested\n`),
        realpath: normalize,
      }),
    ).rejects.toThrow(/does not point under/);
  });

  // gitはポインタを、末尾のCR/LFを除いた"gitdir: <path>"の形でそのまま読む。
  // 空白の入り方が違うと、gitは別の(相対パスの)ディレクトリとして読む。
  const verifyPointer = (pointer: string) =>
    verifyWorktreeGitdir({
      run: createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]).run,
      repoDir: "/tmp/repo",
      dir: WT,
      readTextFile: files(pointer),
      realpath: normalize,
    });

  test("rejects two spaces after gitdir:", async () => {
    await expect(verifyPointer(`gitdir:  ${GITDIR}\n`)).rejects.toThrow(
      /does not point under/,
    );
  });

  test("rejects a trailing space after the path", async () => {
    await expect(verifyPointer(`gitdir: ${GITDIR} \n`)).rejects.toThrow(
      /does not point under/,
    );
  });

  test("rejects a tab after gitdir:", async () => {
    await expect(verifyPointer(`gitdir:\t${GITDIR}\n`)).rejects.toThrow(
      /does not point under/,
    );
  });

  test("accepts the canonical pointer without a trailing newline", async () => {
    await expect(verifyPointer(`gitdir: ${GITDIR}`)).resolves.toBeUndefined();
  });

  test("accepts the canonical pointer with CRLF", async () => {
    await expect(
      verifyPointer(`gitdir: ${GITDIR}\r\n`),
    ).resolves.toBeUndefined();
  });

  test("rejects a relative gitdir path", async () => {
    await expect(
      verifyPointer("gitdir: ../repo/.git/worktrees/contract-smoke-branch\n"),
    ).rejects.toThrow(/does not point under/);
  });

  test("rejects an admin dir whose back-pointer names another worktree", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: files(
          `gitdir: ${GITDIR}\n`,
          "/tmp/repo-worktrees/other/.git\n",
        ),
        realpath: normalize,
      }),
    ).rejects.toThrow(/back-pointer/);
  });
});

describe("readWorktreeGitPointer", () => {
  const WT = "/wt";
  function pointerFs(
    kind: "file" | "symlink" | "dir",
    content = "gitdir: /r\n",
  ) {
    return {
      lstat: async () => ({
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
      }),
      readFile: async () => content,
    };
  }

  test("returns the .git file's content", async () => {
    expect(await readWorktreeGitPointer(WT, pointerFs("file"))).toEqual({
      content: "gitdir: /r\n",
    });
  });

  test("rejects a symlinked .git", async () => {
    await expect(
      readWorktreeGitPointer(WT, pointerFs("symlink")),
    ).rejects.toThrow(/not a regular file/);
  });

  test("rejects a .git directory", async () => {
    await expect(readWorktreeGitPointer(WT, pointerFs("dir"))).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe("assertWorktreeGitPointer", () => {
  const WT = "/wt";
  function pointerFs(kind: "file" | "symlink", content: string) {
    return {
      lstat: async () => ({
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
      }),
      readFile: async () => content,
    };
  }

  test("passes when the pointer is unchanged", async () => {
    await expect(
      assertWorktreeGitPointer(
        WT,
        "gitdir: /r\n",
        pointerFs("file", "gitdir: /r\n"),
      ),
    ).resolves.toBeUndefined();
  });

  test("throws WorktreeGitPointerModifiedError when the content differs", async () => {
    await expect(
      assertWorktreeGitPointer(
        WT,
        "gitdir: /r\n",
        pointerFs("file", "gitdir: /evil\n"),
      ),
    ).rejects.toBeInstanceOf(WorktreeGitPointerModifiedError);
  });

  test("throws WorktreeGitPointerModifiedError when .git became a symlink", async () => {
    await expect(
      assertWorktreeGitPointer(
        WT,
        "gitdir: /r\n",
        pointerFs("symlink", "gitdir: /r\n"),
      ),
    ).rejects.toBeInstanceOf(WorktreeGitPointerModifiedError);
  });

  test("throws WorktreeGitPointerModifiedError when .git is gone", async () => {
    await expect(
      assertWorktreeGitPointer(WT, "gitdir: /r\n", {
        lstat: async () => {
          throw new Error("ENOENT");
        },
        readFile: async () => "",
      }),
    ).rejects.toBeInstanceOf(WorktreeGitPointerModifiedError);
  });

  test("uses the fixed message", async () => {
    await expect(
      assertWorktreeGitPointer(
        WT,
        "gitdir: /r\n",
        pointerFs("file", "gitdir: /evil\n"),
      ),
    ).rejects.toThrow(/^worktree git pointer was modified$/);
  });
});

describe("worktreeGitPointerMatches", () => {
  const WT = "/wt";
  const pointerFs = (content: string) => ({
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    readFile: async () => content,
  });

  test("is true when the pointer is unchanged", async () => {
    expect(
      await worktreeGitPointerMatches(
        WT,
        "gitdir: /r\n",
        pointerFs("gitdir: /r\n"),
      ),
    ).toBe(true);
  });

  test("is false when the pointer changed", async () => {
    expect(
      await worktreeGitPointerMatches(
        WT,
        "gitdir: /r\n",
        pointerFs("gitdir: /evil\n"),
      ),
    ).toBe(false);
  });
});

describe("readAndVerifyWorktreeGitPointer", () => {
  const WT = "/tmp/repo-worktrees/contract-smoke-branch";
  const GOOD = "gitdir: /tmp/repo/.git/worktrees/contract-smoke-branch\n";
  const EVIL = "gitdir: /tmp/evil/.git\n";
  const normalize = async (path: string): Promise<string> => resolve(path);
  /** `.git`を2回目以降に読むと別の中身を返す。読み直していれば検証と記録が食い違う。 */
  function flippingRead(first: string, later: string) {
    let reads = 0;
    return async (path: string): Promise<string> => {
      if (path === `${WT}/.git`) {
        reads += 1;
        return reads === 1 ? first : later;
      }
      if (path.endsWith("/gitdir")) return `${WT}/.git\n`;
      throw new Error(`unexpected read: ${path}`);
    };
  }

  test("records the same bytes it verified", async () => {
    const read = flippingRead(GOOD, EVIL);
    const recorded = await readAndVerifyWorktreeGitPointer({
      run: createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]).run,
      repoDir: "/tmp/repo",
      dir: WT,
      readTextFile: read,
      realpath: normalize,
      pointerFs: {
        lstat: async () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
        readFile: read,
      },
    });
    expect(recorded).toBe(GOOD);
  });

  test("rejects a pointer that does not verify", async () => {
    const read = flippingRead(EVIL, GOOD);
    await expect(
      readAndVerifyWorktreeGitPointer({
        run: createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]).run,
        repoDir: "/tmp/repo",
        dir: WT,
        readTextFile: read,
        realpath: normalize,
        pointerFs: {
          lstat: async () => ({
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
          readFile: read,
        },
      }),
    ).rejects.toThrow(/does not point under/);
  });
});

describe("resolveDefaultBranchHeadSha", () => {
  test("returns the trimmed sha refs/remotes/origin/HEAD points to", async () => {
    const fake = createFakeCommandRunner([
      ok("2222222222222222222222222222222222222c\n"),
    ]);
    const sha = await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    expect(sha).toBe("2222222222222222222222222222222222222c");
  });

  test("reads refs/remotes/origin/HEAD by its full name with show-ref", async () => {
    const fake = createFakeCommandRunner([ok("abc\n")]);
    await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    expect(fake.calls[0]?.argv.slice(-5)).toEqual([
      "show-ref",
      "--verify",
      "--hash",
      "--",
      "refs/remotes/origin/HEAD",
    ]);
  });

  test("does not include GH_TOKEN in env (local-only, no network)", async () => {
    const fake = createFakeCommandRunner([ok("abc\n")]);
    await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    const env = fake.calls[0]?.options?.env ?? {};
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  test("throws when refs/remotes/origin/HEAD does not exist", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: 'refs/remotes/origin/HEAD' - not a valid ref"),
    ]);
    await expect(
      resolveDefaultBranchHeadSha(fake.run, "/repo/main"),
    ).rejects.toThrow(/refs\/remotes\/origin\/HEAD does not exist/);
  });
});

describe("fetchPrHeadRef", () => {
  test("fetches the PR's head ref from origin", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await fetchPrHeadRef(fake.run, "/repo/main", 42, "gh-token");
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["fetch", "origin", "--", "pull/42/head"]),
    );
  });

  test("places the refspec after -- (untrusted-positional-arg convention)", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await fetchPrHeadRef(fake.run, "/repo/main", 42, "gh-token");
    const argv = fake.calls[0]?.argv ?? [];
    const dashIndex = argv.indexOf("--");
    const refspecIndex = argv.indexOf("pull/42/head");
    expect(dashIndex).toBeGreaterThan(-1);
    expect(refspecIndex).toBeGreaterThan(dashIndex);
  });

  test("carries GH_TOKEN in env (network operation)", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await fetchPrHeadRef(fake.run, "/repo/main", 42, "gh-token-xyz");
    const env = fake.calls[0]?.options?.env ?? {};
    expect(env).toMatchObject({ GH_TOKEN: "gh-token-xyz" });
  });

  test("throws a masked error on failure", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: couldn't find remote ref pull/42/head"),
    ]);
    await expect(
      fetchPrHeadRef(fake.run, "/repo/main", 42, "gh-token"),
    ).rejects.toThrow(/pull\/42\/head failed/);
  });
});

describe("readGitShowFile", () => {
  test("throws when the output was abandoned", async () => {
    const fake = createFakeCommandRunner([abandoned("{")]);
    await expect(
      readGitShowFile(fake.run, "/repo/wt", "HEAD", "package.json"),
    ).rejects.toThrow(/git show.*abandoned/);
  });

  test("returns the file's content at the given ref", async () => {
    const fake = createFakeCommandRunner([ok("file contents\n")]);
    const content = await readGitShowFile(
      fake.run,
      "/repo/wt",
      "HEAD",
      "package.json",
    );
    expect(content).toBe("file contents\n");
  });

  test("returns null when the file doesn't exist at that ref, without throwing", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: path 'missing.json' does not exist in 'HEAD'"),
    ]);
    const content = await readGitShowFile(
      fake.run,
      "/repo/wt",
      "HEAD",
      "missing.json",
    );
    expect(content).toBeNull();
  });

  test("does not carry GH_TOKEN in env (local-only read)", async () => {
    const fake = createFakeCommandRunner([ok("x")]);
    await readGitShowFile(fake.run, "/repo/wt", "HEAD", "a.txt");
    const env = fake.calls[0]?.options?.env ?? {};
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  test("does not build ref:path with -- (git show's own rev-parse-like exception — verified empirically: -- silently breaks ref:path lookup)", async () => {
    const fake = createFakeCommandRunner([ok("x")]);
    await readGitShowFile(fake.run, "/repo/wt", "HEAD", "a.txt");
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).not.toContain("--");
    expect(argv).toContain("HEAD:a.txt");
  });

  test("returns null without calling git for a ref that could be misread as a flag", async () => {
    const fake = createFakeCommandRunner([]);
    const content = await readGitShowFile(
      fake.run,
      "/repo/wt",
      "--upload-pack=evil",
      "a.txt",
    );
    expect(content).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

const HEAD_SHA = "0000000000000000000000000000000000000a";
const OTHER_SHA = "1111111111111111111111111111111111111b";
const noopVerify = async (): Promise<void> => {};
const TEST_AUTHOR = {
  name: "factory-bot",
  email: "12345+factory-bot@users.noreply.github.com",
};

function commitAndPushCalls(
  responses: readonly CommandResult[],
): ReturnType<typeof createFakeCommandRunner> {
  return createFakeCommandRunner(responses);
}

describe("withCommitTrailers", () => {
  test("appends the Claude co-author and Generated-By trailers after a blank line", () => {
    const result = withCommitTrailers("fix: something", "acme-factory");
    expect(result).toBe(
      "fix: something\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nGenerated-By: Software Factory (acme-factory)",
    );
  });

  test("is idempotent: does not double the trailers when the message already has them", () => {
    const once = withCommitTrailers("fix: something", "acme-factory");
    const twice = withCommitTrailers(once, "acme-factory");
    expect(twice).toBe(once);
  });
});

describe("commitAndPush", () => {
  test("returns head_changed when the remote branch moved", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"), // symbolic-ref -q HEAD
      ok(), // fetch origin fix/branch
      ok(`${OTHER_SHA}\n`), // show-ref --verify refs/remotes/origin/fix/branch
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ outcome: "head_changed", currentSha: OTHER_SHA });
  });

  test("reads the tracking ref by its full name with show-ref", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[2]?.argv.slice(-5)).toEqual([
      "show-ref",
      "--verify",
      "--hash",
      "--",
      "refs/remotes/origin/fix/branch",
    ]);
  });

  test("throws when the tracking ref does not exist", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      fail("fatal: 'refs/remotes/origin/fix/branch' - not a valid ref", 128),
    ]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/refs\/remotes\/origin\/fix\/branch does not exist/);
  });

  test("fetches without recursing into submodules", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.argv.slice(-4)).toEqual([
      "--no-recurse-submodules",
      "origin",
      "--",
      "fix/branch",
    ]);
  });

  test("runs local git without replace objects", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.options?.env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  test("runs network git without replace objects", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.options?.env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  describe("pr_fix guards", () => {
    /** pr_fixの呼び出しと同じく、ローカルのHEADの確認とステージ済みの変更の検査を有効にする。 */
    function guardedOptions(
      run: ReturnType<typeof commitAndPushCalls>["run"],
      reasons: readonly string[] = [],
    ) {
      return {
        run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
        requireLocalHeadAtExpected: true,
        expectedBranch: "fix/branch",
        inspectStaged: async () => reasons,
      };
    }

    test("throws CommitBlockedError when HEAD is on another branch", async () => {
      const fake = commitAndPushCalls([ok("refs/heads/main\n")]);
      await expect(commitAndPush(guardedOptions(fake.run))).rejects.toThrow(
        "local HEAD is not on branch fix/branch",
      );
    });

    test("throws CommitBlockedError when HEAD is detached", async () => {
      const fake = commitAndPushCalls([fail("", 1)]);
      await expect(
        commitAndPush(guardedOptions(fake.run)),
      ).rejects.toBeInstanceOf(CommitBlockedError);
    });

    test("does not fetch when HEAD is on another branch", async () => {
      const fake = commitAndPushCalls([ok("refs/heads/main\n")]);
      await commitAndPush(guardedOptions(fake.run)).catch(() => {});
      expect(fake.calls).toHaveLength(1);
    });

    test("reads the branch with git symbolic-ref -q HEAD", async () => {
      const fake = commitAndPushCalls([ok("refs/heads/main\n")]);
      await commitAndPush(guardedOptions(fake.run)).catch(() => {});
      expect(fake.calls[0]?.argv.slice(-3)).toEqual([
        "symbolic-ref",
        "-q",
        "HEAD",
      ]);
    });

    test("throws CommitBlockedError when HEAD is a symbolic ref outside refs/heads", async () => {
      const fake = commitAndPushCalls([ok("refs/remotes/origin/fix/branch\n")]);
      await expect(
        commitAndPush(guardedOptions(fake.run)),
      ).rejects.toBeInstanceOf(CommitBlockedError);
    });

    test("throws a git error when symbolic-ref fails for a reason other than a detached HEAD", async () => {
      const fake = commitAndPushCalls([
        fail("fatal: not a git repository", 128),
      ]);
      await expect(commitAndPush(guardedOptions(fake.run))).rejects.toThrow(
        /git symbolic-ref -q HEAD failed/,
      );
    });

    test("throws a git error when symbolic-ref times out", async () => {
      const fake = commitAndPushCalls([
        { stdout: "", stderr: "", exitCode: 1, timedOut: true },
      ]);
      await expect(commitAndPush(guardedOptions(fake.run))).rejects.toThrow(
        /git symbolic-ref -q HEAD failed/,
      );
    });

    test("unstages when the staged inspection throws", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(),
        ok(" M file.ts\n"),
        ok(), // git reset -q
      ]);
      await commitAndPush({
        ...guardedOptions(fake.run),
        inspectStaged: async () => {
          throw new Error("git show failed");
        },
      }).catch(() => {});
      expect(fake.calls.at(-1)?.argv.slice(-2)).toEqual(["reset", "-q"]);
    });

    test("rethrows the staged inspection's error after unstaging", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(),
        ok(" M file.ts\n"),
        ok(),
      ]);
      await expect(
        commitAndPush({
          ...guardedOptions(fake.run),
          inspectStaged: async () => {
            throw new Error("git show failed");
          },
        }),
      ).rejects.toThrow("git show failed");
    });

    test("keeps each stop reason a single reason item", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(),
        ok(" M file.ts\n"),
        ok(), // git reset -q
      ]);
      await expect(
        commitAndPush(
          guardedOptions(fake.run, [
            "forbidden path changed: a; needs human attention",
            "new shell script added: b.sh",
          ]),
        ),
      ).rejects.toThrow(
        "forbidden path changed: a, needs human attention; new shell script added: b.sh",
      );
    });

    test("throws CommitBlockedError when the local HEAD moved off the PR head", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${OTHER_SHA}\n`), // rev-parse --verify HEAD
      ]);
      await expect(
        commitAndPush(guardedOptions(fake.run)),
      ).rejects.toBeInstanceOf(CommitBlockedError);
    });

    test("names both shas when the local HEAD moved", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${OTHER_SHA}\n`),
      ]);
      await expect(commitAndPush(guardedOptions(fake.run))).rejects.toThrow(
        `local HEAD ${OTHER_SHA} is not the PR head ${HEAD_SHA}`,
      );
    });

    test("does not stage anything when the local HEAD moved", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${OTHER_SHA}\n`),
      ]);
      await commitAndPush(guardedOptions(fake.run)).catch(() => {});
      expect(fake.calls.map((call) => call.argv.includes("add"))).not.toContain(
        true,
      );
    });

    test("throws CommitBlockedError with the staged inspection's reasons", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(), // git add -A
        ok(" M mise.toml\n"),
        ok(), // git reset -q
      ]);
      await expect(
        commitAndPush(
          guardedOptions(fake.run, ["forbidden path changed: mise.toml"]),
        ),
      ).rejects.toThrow(/^forbidden path changed: mise.toml$/);
    });

    test("unstages and does not commit after a staged violation", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(),
        ok(" M mise.toml\n"),
        ok(),
      ]);
      await commitAndPush(
        guardedOptions(fake.run, ["forbidden path changed: mise.toml"]),
      ).catch(() => {});
      expect(fake.calls.at(-1)?.argv.slice(-2)).toEqual(["reset", "-q"]);
    });

    test("commits when the local HEAD and the staged changes pass", async () => {
      const newSha = "2222222222222222222222222222222222222c";
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`),
        ok(),
        ok(" M file.ts\n"),
        ok(), // git commit
        ok(`${newSha}\n`), // rev-parse --verify HEAD
        ok(), // git push
      ]);
      const result = await commitAndPush(guardedOptions(fake.run));
      expect(result).toEqual({ outcome: "pushed", newSha });
    });
  });

  describe("expected tree", () => {
    const NEW_COMMIT = "2222222222222222222222222222222222222c";
    const EXPECTED_TREE = "4".repeat(40);

    /** 変更をcommitするところまで進む応答に、commitの後の応答を足す。 */
    function committedCalls(after: readonly CommandResult[]) {
      return commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(), // git add -A
        ok(" M file.ts\n"),
        ok(), // git commit
        ok(`${NEW_COMMIT}\n`), // rev-parse --verify HEAD
        ...after,
      ]);
    }

    function options(run: ReturnType<typeof commitAndPushCalls>["run"]) {
      return {
        run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
        expectedTreeSha: EXPECTED_TREE,
      };
    }

    test("pushes when the committed tree is the expected tree", async () => {
      const fake = committedCalls([ok(`${EXPECTED_TREE}\n`), ok()]);
      expect(await commitAndPush(options(fake.run))).toEqual({
        outcome: "pushed",
        newSha: NEW_COMMIT,
      });
    });

    test("reads the tree of the new commit", async () => {
      const fake = committedCalls([ok(`${EXPECTED_TREE}\n`), ok()]);
      await commitAndPush(options(fake.run));
      expect(fake.calls[7]?.argv.slice(-2)).toEqual([
        "--verify",
        `${NEW_COMMIT}^{tree}`,
      ]);
    });

    test("stops when the committed tree is not the expected tree", async () => {
      const fake = committedCalls([ok(`${TREE_SHA}\n`), ok()]);
      await expect(commitAndPush(options(fake.run))).rejects.toThrow(
        COMMITTED_TREE_CHANGED_REASON,
      );
    });

    test("undoes the commit back to its own parent when the committed tree is not the expected tree", async () => {
      const fake = committedCalls([ok(`${TREE_SHA}\n`), ok()]);
      await commitAndPush(options(fake.run)).catch(() => {});
      expect(fake.calls.at(-1)?.argv.slice(-4)).toEqual([
        "reset",
        "-q",
        `${NEW_COMMIT}~1`,
        "--",
      ]);
    });

    test("undoes the commit back to the expected head when the local HEAD was required there", async () => {
      const fake = commitAndPushCalls([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok(`${HEAD_SHA}\n`),
        ok(`${HEAD_SHA}\n`), // rev-parse --verify HEAD(ローカルのHEADの確かめ)
        ok(), // git add -A
        ok(" M file.ts\n"),
        ok(), // git commit
        ok(`${NEW_COMMIT}\n`),
        ok(`${TREE_SHA}\n`),
        ok(),
      ]);
      await commitAndPush({
        ...options(fake.run),
        requireLocalHeadAtExpected: true,
      }).catch(() => {});
      expect(fake.calls.at(-1)?.argv.slice(-4)).toEqual([
        "reset",
        "-q",
        HEAD_SHA,
        "--",
      ]);
    });

    test("does not push when the committed tree is not the expected tree", async () => {
      const fake = committedCalls([ok(`${TREE_SHA}\n`), ok()]);
      await commitAndPush(options(fake.run)).catch(() => {});
      expect(fake.calls.some((call) => call.argv.includes("push"))).toBe(false);
    });
  });

  test("returns nothing_to_commit when the working tree is clean", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(), // git add -A
      ok(""), // git status --porcelain(空なら変更なし)
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ outcome: "nothing_to_commit" });
  });

  test("commits and pushes when the remote head matches and there are changes", async () => {
    const newSha = "2222222222222222222222222222222222222c";
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(`${newSha}\n`), // rev-parse --verify HEAD
      ok(), // git push
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ outcome: "pushed", newSha });
  });

  test("pushes the new commit by its sha instead of HEAD", async () => {
    const newSha = "2222222222222222222222222222222222222c";
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(`${newSha}\n`), // rev-parse --verify HEAD
      ok(), // git push
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls.at(-1)?.argv.slice(-2)).toEqual([
      "--",
      `${newSha}:refs/heads/fix/branch`,
    ]);
  });

  test("the git commit call's env carries GIT_AUTHOR_EMAIL from the given author", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(`${HEAD_SHA}\n`), // rev-parse --verify HEAD
      ok(), // git push
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    const commitCallEnv = fake.calls[5]?.options?.env; // git commit -m
    expect(commitCallEnv?.GIT_AUTHOR_EMAIL).toBe(TEST_AUTHOR.email);
  });

  test("returns head_changed (not a throw) when push is rejected as non-fast-forward", async () => {
    const raceSha = "3333333333333333333333333333333333333d";
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"), // symbolic-ref -q HEAD
      ok(), // fetch origin fix/branch
      ok(`${HEAD_SHA}\n`), // show-ref --verify refs/remotes/origin/fix/branch(`expectedHeadSha`と一致する)
      ok(), // git add -A
      ok(" M file.ts\n"), // git status --porcelain
      ok(), // git commit
      ok(`${HEAD_SHA}\n`), // rev-parse --verify HEAD
      fail(
        "! [rejected]        fix/branch -> fix/branch (fetch first)\nerror: failed to push some refs",
      ), // git push
      ok(), // 拒否されたあとにorigin fix/branchを取り直す
      ok(`${raceSha}\n`), // 拒否されたあとのshow-ref --verify refs/remotes/origin/fix/branch
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ outcome: "head_changed", currentSha: raceSha });
  });

  test("recognizes a '(non-fast-forward)' phrased rejection too", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      fail("! [rejected] fix/branch -> fix/branch (non-fast-forward)"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result.outcome).toBe("head_changed");
  });

  test("still throws on a push failure that isn't a non-fast-forward rejection (e.g. permission denied)", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      fail(
        "remote: Permission to acme/widgets.git denied to factory-bot.\nfatal: unable to access",
      ),
    ]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/git push failed/);
  });

  test("calls verifyWorktree before running any git command", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(""),
    ]);
    let verifiedBeforeFirstRun = false;
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: async () => {
        verifiedBeforeFirstRun = fake.calls.length === 0;
      },
      lockFs: createInMemoryLockFs(),
    });
    expect(verifiedBeforeFirstRun).toBe(true);
  });

  test("propagates a verifyWorktree rejection without running any git command", async () => {
    const fake = commitAndPushCalls([]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: async () => {
          throw new Error("not a registered worktree");
        },
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/not a registered worktree/);
  });

  test("rejects an expectedHeadSha that isn't valid hex", async () => {
    const fake = commitAndPushCalls([]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: "not-a-sha",
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
      }),
    ).rejects.toThrow();
  });

  test("the push call (network) carries GH_TOKEN but the commit call (local) does not", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-secret",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    const commitCallEnv = fake.calls[5]?.options?.env; // git commit -m
    const pushCallEnv = fake.calls[7]?.options?.env; // git push
    expect([commitCallEnv?.GH_TOKEN, pushCallEnv?.GH_TOKEN]).toEqual([
      undefined,
      "gh-secret",
    ]);
  });

  test("the commit message (argv) carries the Claude co-author and Generated-By trailers", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(`${HEAD_SHA}\n`), // rev-parse --verify HEAD
      ok(), // git push
    ]);
    await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    const commitArgv = fake.calls[5]?.argv ?? [];
    expect(commitArgv).toEqual(
      expect.arrayContaining([
        withCommitTrailers("fix: something", "acme-factory"),
      ]),
    );
  });

  test("throws (not head_changed) when the remote rejects the push, e.g. a PAT without workflow scope", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/factory/issue-7-wi-3\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      fail(
        "! [remote rejected] factory/issue-7-wi-3 -> factory/issue-7-wi-3 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
      ),
    ]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/refusing to allow a Personal Access Token/);
  });

  test("still returns head_changed for a plain '[rejected] ... (non-fast-forward)' push", async () => {
    const fake = commitAndPushCalls([
      ok("refs/heads/main\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      fail("! [rejected] main -> main (non-fast-forward)"),
      ok(),
      ok(`${OTHER_SHA}\n`),
    ]);
    const result = await commitAndPush({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: HEAD_SHA,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result.outcome).toBe("head_changed");
  });

  test("throws without fetching when HEAD is detached and no branch is expected", async () => {
    const fake = commitAndPushCalls([fail("", 1)]);
    await expect(
      commitAndPush({
        run: fake.run,
        repoDir: "/repo",
        dir: "/repo/wt",
        message: "fix: something",
        instanceName: "acme-factory",
        expectedHeadSha: HEAD_SHA,
        author: TEST_AUTHOR,
        ghToken: "gh-token",
        verifyWorktree: noopVerify,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/local HEAD is not on a branch/);
  });
});

describe("remote ref reads (real git)", () => {
  const BRANCH = "fix/branch";
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  type Fixture = {
    readonly repo: string;
    readonly worktree: string;
    readonly home: string;
    readonly headSha: string;
    readonly run: CommandRunner;
    readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
  };

  /**
   * `main`と`fix/branch`を持つoriginのbareリポジトリと、そのcloneの`fix/branch`のworktreeを作り、worktreeのファイルを1つ変える。
   * `HOME`を一時ディレクトリに向け、システムの設定も読ませないので、利用者のgitの設定に左右されない。
   */
  async function setUp(): Promise<Fixture> {
    const root = mkdtempSync(join(tmpdir(), "commit-and-push-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    const home = join(root, "home");
    mkdirSync(seed);
    mkdirSync(home);
    const run: CommandRunner = (argv, options) =>
      runCommand(argv, {
        ...options,
        env: {
          ...options?.env,
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          // モジュールのgitは本番のhttpsだけを許す。テストのoriginはローカルのパスなので、fileも許す。
          GIT_ALLOW_PROTOCOL: "https:file",
        },
      });
    const git = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await run(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    await git(seed, ["init", "-q", "-b", "main"]);
    writeFileSync(join(seed, "README.md"), "readme\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "-q", "-m", "init"]);
    await git(seed, [
      "push",
      "-q",
      origin,
      `main:refs/heads/${BRANCH}`,
      "main",
    ]);
    await git(root, ["clone", "-q", "--no-checkout", origin, repo]);
    await git(repo, ["branch", "--no-track", BRANCH, `origin/${BRANCH}`]);
    await git(repo, ["worktree", "add", "-q", worktree, BRANCH]);
    writeFileSync(join(worktree, "README.md"), "readme\nchanged\n");
    return {
      repo,
      worktree,
      home,
      headSha: await git(repo, ["rev-parse", `origin/${BRANCH}`]),
      run,
      git,
    };
  }

  test("pushes when a tag has the same name as the branch", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.repo, ["tag", BRANCH]);
    const result = await commitAndPush({
      run: fixture.run,
      repoDir: fixture.repo,
      dir: fixture.worktree,
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: fixture.headSha,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      home: fixture.home,
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
      requireLocalHeadAtExpected: true,
      expectedBranch: BRANCH,
    });
    expect(result.outcome).toBe("pushed");
  });

  /** リモートの先頭とは別のcommitを作り、`shadowRef`にrefとして置く。 */
  async function plantShadowRef(
    fixture: Fixture,
    shadowRef: string,
  ): Promise<void> {
    const shadowSha = await fixture.git(fixture.repo, [
      "commit-tree",
      `${fixture.headSha}^{tree}`,
      "-m",
      "shadow",
    ]);
    await fixture.git(fixture.repo, ["update-ref", shadowRef, shadowSha]);
  }

  function pushFrom(fixture: Fixture) {
    return commitAndPush({
      run: fixture.run,
      repoDir: fixture.repo,
      dir: fixture.worktree,
      message: "fix: something",
      instanceName: "acme-factory",
      expectedHeadSha: fixture.headSha,
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      home: fixture.home,
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
      requireLocalHeadAtExpected: true,
      expectedBranch: BRANCH,
    });
  }

  test("pushes when a refs/heads/origin/<branch> ref shadows the tracking ref", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, `refs/heads/origin/${BRANCH}`);
    const result = await pushFrom(fixture);
    expect(result.outcome).toBe("pushed");
  });

  test("pushes when a refs/tags/origin/<branch> tag shadows the tracking ref", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, `refs/tags/origin/${BRANCH}`);
    const result = await pushFrom(fixture);
    expect(result.outcome).toBe("pushed");
  });

  test("currentRemoteHeadSha ignores a refs/heads/origin/<branch> shadow ref", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, `refs/heads/origin/${BRANCH}`);
    const sha = await currentRemoteHeadSha({
      run: fixture.run,
      repoDir: fixture.repo,
      branch: BRANCH,
      home: fixture.home,
    });
    expect(sha).toBe(fixture.headSha);
  });

  test("currentRemoteHeadSha ignores a refs/tags/origin/<branch> shadow tag", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, `refs/tags/origin/${BRANCH}`);
    const sha = await currentRemoteHeadSha({
      run: fixture.run,
      repoDir: fixture.repo,
      branch: BRANCH,
      home: fixture.home,
    });
    expect(sha).toBe(fixture.headSha);
  });

  /** 追跡refを消し、`refs/heads/`の下に`refs/remotes/...`と同じ綴りのrefだけを置く。 */
  async function replaceTrackingRefWithHeadsLookalike(
    fixture: Fixture,
  ): Promise<void> {
    await plantShadowRef(fixture, `refs/heads/refs/remotes/origin/${BRANCH}`);
    await fixture.git(fixture.repo, [
      "update-ref",
      "-d",
      `refs/remotes/origin/${BRANCH}`,
    ]);
  }

  test("readExactRef returns the sha of the exact ref", async () => {
    const fixture = await setUp();
    const sha = await readExactRef({
      run: fixture.run,
      cwd: fixture.repo,
      env: { HOME: fixture.home },
      ref: `refs/remotes/origin/${BRANCH}`,
    });
    expect(sha).toBe(fixture.headSha);
  });

  test("readExactRef returns null when only refs/heads/<ref> exists", async () => {
    const fixture = await setUp();
    await replaceTrackingRefWithHeadsLookalike(fixture);
    const sha = await readExactRef({
      run: fixture.run,
      cwd: fixture.repo,
      env: { HOME: fixture.home },
      ref: `refs/remotes/origin/${BRANCH}`,
    });
    expect(sha).toBeNull();
  });

  test("currentRemoteHeadSha returns null when only refs/heads/refs/remotes/origin/<branch> exists", async () => {
    const fixture = await setUp();
    await replaceTrackingRefWithHeadsLookalike(fixture);
    const sha = await currentRemoteHeadSha({
      run: fixture.run,
      repoDir: fixture.repo,
      branch: BRANCH,
      home: fixture.home,
    });
    expect(sha).toBeNull();
  });

  test("resolveDefaultBranchHeadSha ignores a refs/heads/origin/HEAD ref", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, "refs/heads/origin/HEAD");
    const sha = await resolveDefaultBranchHeadSha(fixture.run, fixture.repo);
    expect(sha).toBe(fixture.headSha);
  });

  test("resolveDefaultBranchHeadSha ignores a refs/tags/origin/HEAD tag", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, "refs/tags/origin/HEAD");
    const sha = await resolveDefaultBranchHeadSha(fixture.run, fixture.repo);
    expect(sha).toBe(fixture.headSha);
  });

  test("resolveDefaultBranchName returns the branch when a refs/heads/origin/main ref exists", async () => {
    const fixture = await setUp();
    await plantShadowRef(fixture, "refs/heads/origin/main");
    const name = await resolveDefaultBranchName({
      run: fixture.run,
      repoDir: fixture.repo,
      home: fixture.home,
    });
    expect(name).toBe("main");
  });

  const NEW_BRANCH = "fix/new-branch";

  /**
   * gtr 2.11.1が、リモートにもローカルにも無いブランチを作るときの操作を、実際のgitで行う実行関数を返す。
   * 短い名前の`origin/main^{commit}`をshaに解決し、そのshaから`git worktree add -b`で作る。
   * gtrが入っていない環境でも照合を試すために、`git gtr new`の呼び出しだけを差し替える。
   */
  function gtrNewBranchEmulator(fixture: Fixture, path: string): CommandRunner {
    return async (argv, options) => {
      if (!argv.includes("gtr")) return fixture.run(argv, options);
      const resolved = await fixture.git(fixture.repo, [
        "rev-parse",
        "--verify",
        "origin/main^{commit}",
      ]);
      await fixture.git(fixture.repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        NEW_BRANCH,
        path,
        resolved,
      ]);
      // gtrのコピーなどが作りうる、検証したtreeの.gitignoreが除外するファイル。
      mkdirSync(join(path, "node_modules"));
      writeFileSync(join(path, "node_modules", "planted.js"), "planted\n");
      return {
        // gtrは実体のパスを返す(macOSの一時ディレクトリはsymlink越しになる)。
        stdout: `path\t${realpathSync(path)}\nbranch\t${NEW_BRANCH}\nhook_status\tnone\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
  }

  async function createNewBranchWorktree(fixture: Fixture) {
    // 検証する既定のブランチのtreeに、node_modules/を除外する.gitignoreを置く。
    writeFileSync(join(fixture.worktree, ".gitignore"), "node_modules/\n");
    await fixture.git(fixture.worktree, ["add", ".gitignore"]);
    await fixture.git(fixture.worktree, ["commit", "-q", "-m", "ignore"]);
    await fixture.git(fixture.worktree, [
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/main",
    ]);
    await fixture.git(fixture.repo, ["fetch", "-q", "origin"]);
    await plantShadowRef(fixture, "refs/heads/origin/main");
    return createGtrWorktree({
      run: gtrNewBranchEmulator(fixture, `${fixture.worktree}-new`),
      repoDir: fixture.repo,
      branch: NEW_BRANCH,
      ghToken: "gh-token",
      home: fixture.home,
      assertProcessesIdle: async () => false,
      lockFs: createInMemoryLockFs(),
    });
  }

  test("createGtrWorktree puts a new branch's worktree at the default branch head despite a refs/heads/origin/main ref", async () => {
    const fixture = await setUp();
    const created = await createNewBranchWorktree(fixture);
    expect(await fixture.git(created.path, ["rev-parse", "HEAD"])).toBe(
      await fixture.git(fixture.repo, [
        "rev-parse",
        "refs/remotes/origin/main",
      ]),
    );
  });

  test("createGtrWorktree removes ignored files that a wrongly created tree left behind", async () => {
    const fixture = await setUp();
    const created = await createNewBranchWorktree(fixture);
    expect(existsSync(join(created.path, "node_modules", "planted.js"))).toBe(
      false,
    );
  });

  test("createGtrWorktree moves a new branch to the default branch head despite a refs/heads/origin/main ref", async () => {
    const fixture = await setUp();
    await createNewBranchWorktree(fixture);
    expect(
      await fixture.git(fixture.repo, [
        "rev-parse",
        `refs/heads/${NEW_BRANCH}`,
      ]),
    ).toBe(
      await fixture.git(fixture.repo, [
        "rev-parse",
        "refs/remotes/origin/main",
      ]),
    );
  });

  test("createGtrWorktree resets a pre-existing local branch that differs from the tracking ref", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.worktree, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local only",
    ]);
    await fixture.git(fixture.repo, [
      "worktree",
      "remove",
      "--force",
      fixture.worktree,
    ]);
    const path = `${fixture.worktree}-new`;
    // gtrはローカルのブランチがあればそのまま使うので、`git worktree add`だけを行う。
    const run: CommandRunner = async (argv, options) => {
      if (!argv.includes("gtr")) return fixture.run(argv, options);
      await fixture.git(fixture.repo, ["worktree", "add", "-q", path, BRANCH]);
      return {
        stdout: `path\t${realpathSync(path)}\nbranch\t${BRANCH}\nhook_status\tdisabled\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
    const created = await createGtrWorktree({
      run,
      repoDir: fixture.repo,
      branch: BRANCH,
      ghToken: "gh-token",
      home: fixture.home,
      assertProcessesIdle: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(await fixture.git(created.path, ["rev-parse", "HEAD"])).toBe(
      fixture.headSha,
    );
  });

  test("createGtrWorktree reuse resets to the tracking ref despite a refs/heads/origin/<branch> ref", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.worktree, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local only",
    ]);
    await plantShadowRef(fixture, `refs/heads/origin/${BRANCH}`);
    await createGtrWorktree({
      run: fixture.run,
      repoDir: fixture.repo,
      branch: BRANCH,
      ghToken: "gh-token",
      home: fixture.home,
      assertProcessesIdle: async () => false,
      lockFs: createInMemoryLockFs(),
    });
    expect(await fixture.git(fixture.worktree, ["rev-parse", "HEAD"])).toBe(
      fixture.headSha,
    );
  });
});

describe("repo-wide lock scope (code-review fix)", () => {
  test("ensureRepo, addDetachedWorktree, and commitAndPush all lock the same path for the same repo", async () => {
    const lockPath = "/workspaces/acme/widgets/main.lock";
    const seenLockPaths = new Set<string>();
    const lockFs: LockFs = {
      tryCreate: async (path) => {
        seenLockPaths.add(path);
        return true;
      },
      read: async () => null,
      mtimeMs: async () => null,
      remove: async () => {},
    };

    await ensureRepo({
      run: createFakeCommandRunner([ok(), ok(), ok()]).run,
      owner: "acme",
      repo: "widgets",
      ghToken: "gh-token",
      exists: async () => false,
      lockFs,
    });

    await addDetachedWorktree({
      run: createFakeCommandRunner([ok(), ok()]).run,
      repoDir: "/workspaces/acme/widgets/main",
      sha: "abc1234",
      dir: "/workspaces/acme/widgets/wt",
      ghToken: "gh-token",
      lockFs,
    });

    await commitAndPush({
      run: createFakeCommandRunner([
        ok("refs/heads/fix/branch\n"),
        ok(),
        ok("abc1234\n"),
        ok(""),
        ok(""),
      ]).run,
      repoDir: "/workspaces/acme/widgets/main",
      dir: "/workspaces/acme/widgets/wt",
      message: "fix: x",
      instanceName: "acme-factory",
      expectedHeadSha: "abc1234",
      author: TEST_AUTHOR,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs,
    });

    expect(seenLockPaths).toEqual(new Set([lockPath]));
  });
});

describe("ensureEmptyDir", () => {
  test("creates the directory when it does not exist yet", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-ensure-empty-dir-"));
    const dir = join(base, "docdir");
    await ensureEmptyDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  test("removes an existing directory's stray contents before recreating it", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-ensure-empty-dir-"));
    const dir = join(base, "docdir");
    mkdirSync(dir);
    writeFileSync(join(dir, "stray.txt"), "leftover from a previous attempt");
    await ensureEmptyDir(dir);
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
  });
});

describe("readDirEntries / readTextFile / writeTextFile / copyFileTo", () => {
  test("readDirEntries lists a directory's entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-readdir-"));
    writeFileSync(join(dir, "requirements.md"), "# a");
    writeFileSync(join(dir, "flow.drawio"), "<mxfile/>");
    const entries = await readDirEntries(dir);
    expect(entries.sort()).toEqual(["flow.drawio", "requirements.md"]);
  });

  test("writeTextFile then readTextFile round-trips the content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-readwrite-"));
    const path = join(dir, "requirements.md");
    await writeTextFile(path, "# hello");
    expect(await readTextFile(path)).toBe("# hello");
  });

  test("copyFileTo copies a file's content to a new path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-copy-"));
    const source = join(dir, "template.md");
    writeFileSync(source, "template body");
    const destination = join(dir, "requirements.md");
    await copyFileTo(source, destination);
    expect(await readTextFile(destination)).toBe("template body");
  });
});

describe("removeEmptyDir", () => {
  test("removes an empty directory and returns true", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-remove-empty-dir-"));
    const dir = join(base, "issue-1");
    mkdirSync(dir);
    const removed = await removeEmptyDir(dir);
    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("returns false without throwing for a non-empty directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-remove-empty-dir-"));
    const dir = join(base, "issue-1");
    mkdirSync(dir);
    writeFileSync(join(dir, "wi-1"), "");
    const removed = await removeEmptyDir(dir);
    expect(removed).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  test("returns false without throwing for a directory that doesn't exist", async () => {
    const removed = await removeEmptyDir("/nonexistent/path/for/sure");
    expect(removed).toBe(false);
  });
});

describe("pushNewBranch", () => {
  const BRANCH = "factory/issue-7-wi-3";
  const PUSH_BASE_SHA = "a".repeat(40);
  const BRANCH_SHA = "c".repeat(40);
  /** `git ls-remote --symref origin HEAD <branch> <base>`の出力。 */
  const lsRemote = (
    options: {
      readonly head?: string;
      readonly base?: string | null;
      readonly branch?: boolean;
    } = {},
  ): CommandResult =>
    ok(
      [
        `ref: ${options.head ?? "refs/heads/main"}\tHEAD`,
        `${PUSH_BASE_SHA}\tHEAD`,
        ...(options.base === null
          ? []
          : [`${options.base ?? PUSH_BASE_SHA}\trefs/heads/main`]),
        // パターンは末尾で一致するので、名前の終わりが同じ別のrefも返りうる。
        `${BRANCH_SHA}\trefs/heads/x/refs/heads/main`,
        ...(options.branch === true
          ? [`${BRANCH_SHA}\trefs/heads/${BRANCH}`]
          : []),
        "",
      ].join("\n"),
    );
  /** リモートにブランチが無いときの、問い合わせ・追跡refの読み取り・update-ref・pushの応答。 */
  const missingRemote = (): CommandResult[] => [
    lsRemote(),
    ok(`${PUSH_BASE_SHA}\n`), // rev-parse --verify refs/remotes/origin/main^{commit}
    ok(), // update-ref
    ok(), // push
  ];
  const push = (run: CommandRunner, overrides: { baseBranch?: string } = {}) =>
    pushNewBranch({
      run,
      repoDir: "/repo/main",
      branch: BRANCH,
      baseBranch: overrides.baseBranch ?? "main",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });

  test("pushes the branch when the remote does not have it yet", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    const result = await push(fake.run);
    expect(result).toEqual({ pushed: true, baseSha: PUSH_BASE_SHA });
  });

  test("asks the remote for HEAD, the branch and the base in one ls-remote without --", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls[0]?.argv.slice(-6)).toEqual([
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
      `refs/heads/${BRANCH}`,
      "refs/heads/main",
    ]);
  });

  test("reads the local remote-tracking ref of the base to compare", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls[1]?.argv.slice(-5)).toEqual([
      "show-ref",
      "--verify",
      "--hash",
      "--",
      "refs/remotes/origin/main",
    ]);
  });

  test("points the local branch itself at the remote's base before pushing", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls[2]?.argv).toEqual(
      expect.arrayContaining([
        "update-ref",
        "--no-deref",
        "--",
        `refs/heads/${BRANCH}`,
        PUSH_BASE_SHA,
      ]),
    );
  });

  test("pushes the remote's base sha rather than the local branch", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls[3]?.argv.slice(-3)).toEqual([
      "origin",
      "--",
      `${PUSH_BASE_SHA}:refs/heads/${BRANCH}`,
    ]);
  });

  test("runs every git call in repoDir", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls.map((call) => call.options?.cwd)).toEqual([
      "/repo/main",
      "/repo/main",
      "/repo/main",
      "/repo/main",
    ]);
  });

  test("is a no-op when the remote already has the branch", async () => {
    const fake = createFakeCommandRunner([
      lsRemote({ branch: true }),
      ok(`${PUSH_BASE_SHA}\n`),
    ]);
    const result = await push(fake.run);
    expect(result).toEqual({ pushed: false, baseSha: PUSH_BASE_SHA });
  });

  test("does not move or push when the remote already has the branch", async () => {
    const fake = createFakeCommandRunner([
      lsRemote({ branch: true }),
      ok(`${PUSH_BASE_SHA}\n`),
    ]);
    await push(fake.run);
    expect(fake.calls).toHaveLength(2);
  });

  test("only the network calls (ls-remote and push) carry GH_TOKEN", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(fake.calls.map((call) => call.options?.env?.GH_TOKEN)).toEqual([
      "gh-token",
      undefined,
      undefined,
      "gh-token",
    ]);
  });

  test("every git call disables replace refs", async () => {
    const fake = createFakeCommandRunner(missingRemote());
    await push(fake.run);
    expect(
      fake.calls.map((call) => call.options?.env?.GIT_NO_REPLACE_OBJECTS),
    ).toEqual(["1", "1", "1", "1"]);
  });

  test("throws a masked error when the push fails", async () => {
    const fake = createFakeCommandRunner([
      lsRemote(),
      ok(`${PUSH_BASE_SHA}\n`),
      ok(),
      fail("remote: Permission to acme/widgets.git denied to factory-bot."),
    ]);
    await expect(push(fake.run)).rejects.toThrow(
      /git push origin .*:refs\/heads\/factory\/issue-7-wi-3 failed/,
    );
  });

  test("throws without moving the branch when the local tracking ref differs from the remote's base", async () => {
    const fake = createFakeCommandRunner([lsRemote(), ok(`${BRANCH_SHA}\n`)]);
    await expect(push(fake.run)).rejects.toThrow(/does not match/);
  });

  test("throws when the local tracking ref differs even though the remote already has the branch", async () => {
    const fake = createFakeCommandRunner([
      lsRemote({ branch: true }),
      ok(`${BRANCH_SHA}\n`),
    ]);
    await expect(push(fake.run)).rejects.toThrow(/does not match/);
  });

  test("throws when the remote does not have the base branch", async () => {
    const fake = createFakeCommandRunner([lsRemote({ base: null })]);
    await expect(push(fake.run)).rejects.toThrow(
      /origin has no refs\/heads\/main/,
    );
  });

  test("throws when the remote's HEAD is not the base branch", async () => {
    const fake = createFakeCommandRunner([
      lsRemote({ head: "refs/heads/trunk" }),
    ]);
    await expect(push(fake.run)).rejects.toThrow(/origin HEAD/);
  });

  test("throws when the remote's base is not a sha", async () => {
    const fake = createFakeCommandRunner([lsRemote({ base: "not-a-sha" })]);
    await expect(push(fake.run)).rejects.toThrow(/invalid git SHA/);
  });

  test("throws when the ls-remote output was abandoned", async () => {
    const fake = createFakeCommandRunner([
      { ...lsRemote(), outputAbandoned: true },
    ]);
    await expect(push(fake.run)).rejects.toThrow(/abandoned/);
  });

  test("throws without moving the branch when the tracking ref cannot be read", async () => {
    const fake = createFakeCommandRunner([
      lsRemote(),
      fail("fatal: 'refs/remotes/origin/main' - not a valid ref", 128),
    ]);
    await expect(push(fake.run)).rejects.toThrow(
      /refs\/remotes\/origin\/main does not exist/,
    );
  });

  test("throws without pushing when moving the local branch fails", async () => {
    const fake = createFakeCommandRunner([
      lsRemote(),
      ok(`${PUSH_BASE_SHA}\n`),
      fail("fatal: cannot lock ref"),
    ]);
    await expect(push(fake.run)).rejects.toThrow(/update-ref/);
  });

  test("throws when ls-remote fails", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: could not read from remote repository", 128),
    ]);
    await expect(push(fake.run)).rejects.toThrow(/ls-remote/);
  });

  test("rejects an invalid branch name before spawning anything", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      pushNewBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: "-evil",
        baseBranch: "main",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/invalid branch name/);
  });

  test("rejects an invalid base branch name before spawning anything", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(push(fake.run, { baseBranch: "-evil" })).rejects.toThrow(
      /invalid branch name/,
    );
  });

  test("is serialized under the same lock path other repo-tree git ops use", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = createFakeCommandRunner(missingRemote());
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/repo/main.lock")) !== null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await pushNewBranch({
      run: runAndCheck,
      repoDir: "/repo/main",
      branch: BRANCH,
      baseBranch: "main",
      ghToken: "gh-token",
      lockFs,
    });
    expect(sawLockDuringRun).toBe(true);
  });
});

describe("pushNewBranch (real git)", () => {
  const BRANCH = "factory/issue-7-wi-3";
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  type Fixture = {
    readonly origin: string;
    readonly repo: string;
    readonly worktree: string;
    readonly home: string;
    readonly baseSha: string;
    readonly unscannedSha: string;
    readonly run: CommandRunner;
    readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
  };

  /**
   * `main`と`other`を持つoriginのbareリポジトリと、その`--no-checkout`のclone、実装ブランチのworktreeを作る。
   * worktreeのブランチには、検査していないcommitを1つ載せる。
   * リモートのブランチを消した後に、検査コマンドのcommitがローカルのブランチに残った状態を表す。
   * `HOME`を一時ディレクトリに向け、システムの設定も読ませないので、利用者のgitの設定に左右されない。
   */
  async function setUp(): Promise<Fixture> {
    const root = mkdtempSync(join(tmpdir(), "push-new-branch-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    const home = join(root, "home");
    mkdirSync(seed);
    mkdirSync(home);
    const run: CommandRunner = (argv, options) =>
      runCommand(argv, {
        ...options,
        env: {
          ...options?.env,
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          // モジュールのgitは本番のhttpsだけを許す。テストのoriginはローカルのパスなので、fileも許す。
          GIT_ALLOW_PROTOCOL: "https:file",
        },
      });
    const git = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await run(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    await git(seed, ["init", "-q", "-b", "main"]);
    await git(seed, ["commit", "-q", "--allow-empty", "-m", "init"]);
    await git(seed, ["push", "-q", origin, "main", "main:refs/heads/other"]);
    await git(root, ["clone", "-q", "--no-checkout", origin, repo]);
    await git(repo, ["branch", "--no-track", BRANCH, "origin/main"]);
    await git(repo, ["worktree", "add", "-q", worktree, BRANCH]);
    await git(worktree, ["commit", "-q", "--allow-empty", "-m", "unscanned"]);
    return {
      origin,
      repo,
      worktree,
      home,
      baseSha: await git(repo, ["rev-parse", "origin/main"]),
      unscannedSha: await git(repo, ["rev-parse", BRANCH]),
      run,
      git,
    };
  }

  const publish = (fixture: Fixture, baseBranch = "main") =>
    pushNewBranch({
      run: fixture.run,
      repoDir: fixture.repo,
      branch: BRANCH,
      baseBranch,
      ghToken: "gh-token",
      home: fixture.home,
      lockFs: createInMemoryLockFs(),
    });

  /** 実装フローの準備と同じく、メインのcloneの`origin/HEAD`から既定のブランチの名前を読む。 */
  const defaultBranch = (fixture: Fixture) =>
    resolveDefaultBranchName({
      run: fixture.run,
      repoDir: fixture.repo,
      home: fixture.home,
    });

  /** 検査コマンドが書き換えうる、ローカルの追跡refを検査していないcommitに向ける。 */
  const poisonTrackingRef = (fixture: Fixture) =>
    fixture.git(fixture.repo, [
      "update-ref",
      "refs/remotes/origin/main",
      fixture.unscannedSha,
    ]);

  /** originに`BRANCH`があれば終了コード0を返す。 */
  const originBranchProbe = async (fixture: Fixture) =>
    (
      await fixture.run(
        ["git", "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`],
        { cwd: fixture.origin },
      )
    ).exitCode;

  test("publishes the branch at the base", async () => {
    const fixture = await setUp();
    await publish(fixture);
    expect(
      await fixture.git(fixture.origin, ["rev-parse", `refs/heads/${BRANCH}`]),
    ).toBe(fixture.baseSha);
  });

  test("does not send the unscanned local commit to origin", async () => {
    const fixture = await setUp();
    await publish(fixture);
    const probe = await fixture.run(
      ["git", "cat-file", "-e", `${fixture.unscannedSha}^{commit}`],
      { cwd: fixture.origin },
    );
    expect(probe.exitCode).not.toBe(0);
  });

  test("points the checked-out local branch at the base", async () => {
    const fixture = await setUp();
    await publish(fixture);
    expect(
      await fixture.git(fixture.repo, ["rev-parse", `refs/heads/${BRANCH}`]),
    ).toBe(fixture.baseSha);
  });

  test("does not move the branch a symbolic local branch points to", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.repo, ["branch", "-q", "other-local", BRANCH]);
    await fixture.git(fixture.repo, [
      "worktree",
      "remove",
      "--force",
      join(fixture.repo, "..", "wt"),
    ]);
    await fixture.git(fixture.repo, [
      "symbolic-ref",
      `refs/heads/${BRANCH}`,
      "refs/heads/other-local",
    ]);
    await publish(fixture);
    expect(await fixture.git(fixture.repo, ["rev-parse", "other-local"])).toBe(
      fixture.unscannedSha,
    );
  });

  test("a refs/heads/origin/<base> shadow ref does not change the comparison base", async () => {
    const fixture = await setUp();
    // リモートにブランチを先に作り、ローカルのブランチ(検査していないcommit)を動かさない経路にする。
    await fixture.git(fixture.repo, [
      "push",
      "-q",
      "origin",
      `${fixture.baseSha}:refs/heads/${BRANCH}`,
    ]);
    await fixture.git(fixture.repo, [
      "update-ref",
      "refs/heads/origin/main",
      fixture.unscannedSha,
    ]);
    const published = await publish(fixture);
    expect(
      await mergeBaseSha({
        run: fixture.run,
        worktreeDir: fixture.worktree,
        baseSha: published.baseSha,
        home: fixture.home,
      }),
    ).toBe(fixture.baseSha);
  });

  test("throws when the local tracking ref of the base was rewritten", async () => {
    const fixture = await setUp();
    await poisonTrackingRef(fixture);
    await expect(publish(fixture)).rejects.toThrow(/does not match/);
  });

  test("pushes nothing when the local tracking ref of the base was rewritten", async () => {
    const fixture = await setUp();
    await poisonTrackingRef(fixture);
    // 例外を投げることは別のテストで確かめる。ここではpushの有無だけを見る。
    await publish(fixture).catch(() => {});
    expect(await originBranchProbe(fixture)).not.toBe(0);
  });

  test("throws when origin/HEAD was pointed at a branch origin does not have", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.repo, [
      "update-ref",
      "refs/remotes/origin/evil",
      fixture.unscannedSha,
    ]);
    await fixture.git(fixture.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/evil",
    ]);
    await expect(
      publish(fixture, await defaultBranch(fixture)),
    ).rejects.toThrow(/origin HEAD/);
  });

  test("throws when origin/HEAD was pointed at another branch origin has", async () => {
    const fixture = await setUp();
    await fixture.git(fixture.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/other",
    ]);
    await expect(
      publish(fixture, await defaultBranch(fixture)),
    ).rejects.toThrow(/origin HEAD/);
  });
});

describe("deleteRemoteBranch", () => {
  const BRANCH = "factory/issue-7-wi-3";

  test("returns deleted: true when the push --delete succeeds", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const result = await deleteRemoteBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ deleted: true });
  });

  test("runs git push --delete origin -- <branch>", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await deleteRemoteBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["push", "--delete", "origin", "--", BRANCH]),
    );
  });

  test("carries GH_TOKEN in env (network operation)", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await deleteRemoteBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-secret",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.options?.env?.GH_TOKEN).toBe("gh-secret");
  });

  test("returns deleted: false without throwing when the remote ref does not exist", async () => {
    const fake = createFakeCommandRunner([
      fail(
        "error: unable to delete 'factory/issue-7-wi-3': remote ref does not exist\nerror: failed to push some refs",
      ),
    ]);
    const result = await deleteRemoteBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ deleted: false });
  });

  test("throws a masked error on any other failure", async () => {
    const fake = createFakeCommandRunner([
      fail("remote: Permission to acme/widgets.git denied to factory-bot."),
    ]);
    await expect(
      deleteRemoteBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: BRANCH,
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/push --delete/);
  });

  test("rejects an invalid branch name before spawning anything", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      deleteRemoteBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: "feature..evil",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/invalid branch name/);
  });
});

describe("readExactRef", () => {
  const REF = "refs/remotes/origin/main";
  const read = (fake: ReturnType<typeof createFakeCommandRunner>) =>
    readExactRef({ run: fake.run, cwd: "/repo", env: {}, ref: REF });

  test("returns null when git reports the ref as not valid", async () => {
    const fake = createFakeCommandRunner([
      fail(`fatal: '${REF}' - not a valid ref`, 128),
    ]);
    expect(await read(fake)).toBeNull();
  });

  test("throws with git's stderr when git fails for another reason", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: detected dubious ownership in repository", 128),
    ]);
    await expect(read(fake)).rejects.toThrow(/dubious ownership/);
  });

  test("throws when git succeeds without printing a sha", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await expect(read(fake)).rejects.toThrow(/empty/);
  });

  test("throws when the ref is not a full name", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      readExactRef({
        run: fake.run,
        cwd: "/repo",
        env: {},
        ref: "origin/main",
      }),
    ).rejects.toThrow(/full ref name/);
  });

  test("asks git for messages in the C locale", async () => {
    const fake = createFakeCommandRunner([ok(`${HEAD_SHA}\n`)]);
    await read(fake);
    expect(fake.calls[0]?.options?.env?.LC_ALL).toBe("C");
  });
});

describe("currentRemoteHeadSha", () => {
  test("throws when git fails for a reason other than a missing ref", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: detected dubious ownership in repository", 128),
    ]);
    await expect(
      currentRemoteHeadSha({
        run: fake.run,
        repoDir: "/repo/main",
        branch: "factory/issue-7-wi-3",
      }),
    ).rejects.toThrow(/dubious ownership/);
  });

  const BRANCH = "factory/issue-7-wi-3";

  test("returns the trimmed sha origin/<branch> points to", async () => {
    const fake = createFakeCommandRunner([ok(`${HEAD_SHA}\n`)]);
    const sha = await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(sha).toBe(HEAD_SHA);
  });

  test("returns null when refs/remotes/origin/<branch> does not exist", async () => {
    const fake = createFakeCommandRunner([
      fail(`fatal: 'refs/remotes/origin/${BRANCH}' - not a valid ref`, 128),
    ]);
    const sha = await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(sha).toBeNull();
  });

  test("reads refs/remotes/origin/<branch> by its full name with show-ref", async () => {
    const fake = createFakeCommandRunner([ok(`${HEAD_SHA}\n`)]);
    await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(fake.calls[0]?.argv.slice(-5)).toEqual([
      "show-ref",
      "--verify",
      "--hash",
      "--",
      `refs/remotes/origin/${BRANCH}`,
    ]);
  });

  test("does not include GH_TOKEN in env (local-only read)", async () => {
    const fake = createFakeCommandRunner([ok(`${HEAD_SHA}\n`)]);
    await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(fake.calls[0]?.options?.env ?? {}).not.toHaveProperty("GH_TOKEN");
  });

  test("throws when git prints something that is not a sha", async () => {
    const fake = createFakeCommandRunner([ok("not-a-sha\n")]);
    await expect(
      currentRemoteHeadSha({
        run: fake.run,
        repoDir: "/repo/main",
        branch: BRANCH,
      }),
    ).rejects.toThrow();
  });
});

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("readStreamCapped", () => {
  test("returns the whole text when it fits", async () => {
    expect(await readStreamCapped(streamOf("abc", "def"), 100)).toBe("abcdef");
  });

  test("keeps the first and last halves around an omission marker", async () => {
    expect(await readStreamCapped(streamOf("0123456789"), 4)).toBe(
      `01${omittedMarker(6)}89`,
    );
  });

  test("counts omitted bytes across chunk boundaries", async () => {
    expect(await readStreamCapped(streamOf("ab", "cd", "ef", "gh"), 4)).toBe(
      `ab${omittedMarker(4)}gh`,
    );
  });

  test("keeps only the tail of a chunk larger than the tail limit", async () => {
    expect(await readStreamCapped(streamOf("ab", "cdefghij"), 4)).toBe(
      `ab${omittedMarker(6)}ij`,
    );
  });
});

describe("isCappedOutput", () => {
  test("detects the omission marker", () => {
    expect(isCappedOutput(`head${omittedMarker(12)}tail`)).toBe(true);
  });

  test("does not flag uncapped text", () => {
    expect(isCappedOutput("[]")).toBe(false);
  });
});

/** 1回enqueueした後に閉じないストリーム。読み取りは取り消すまで終わらない。 */
function openStreamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  });
}

describe("readStreamAll", () => {
  test("returns the whole text of a closed stream", async () => {
    expect(await readStreamAll(streamOf("abc", "def"))).toBe("abcdef");
  });

  test("returns what it read when the signal aborts", async () => {
    const controller = new AbortController();
    const reading = readStreamAll(openStreamOf("abc"), controller.signal);
    await Bun.sleep(10);
    controller.abort();
    expect(await reading).toBe("abc");
  });
});

describe("readStreamCapped with a signal", () => {
  test("returns what it kept when the signal aborts", async () => {
    const controller = new AbortController();
    const reading = readStreamCapped(
      openStreamOf("abc"),
      100,
      controller.signal,
    );
    await Bun.sleep(10);
    controller.abort();
    expect(await reading).toBe("abc");
  });
});

describe("createBunCommandRunner maxOutputBytes", () => {
  test("keeps at most maxOutputBytes of stdout plus the marker", async () => {
    const result = await runCommand(["sh", "-c", "yes x | head -c 100000"], {
      maxOutputBytes: 1000,
    });
    expect(result.stdout.length).toBeLessThan(1100);
  });

  test("marks capped stdout with the omission marker", async () => {
    const result = await runCommand(["sh", "-c", "yes x | head -c 100000"], {
      maxOutputBytes: 1000,
    });
    expect(isCappedOutput(result.stdout)).toBe(true);
  });

  test("caps stderr independently", async () => {
    const result = await runCommand(
      ["sh", "-c", "yes x | head -c 100000 1>&2"],
      { maxOutputBytes: 1000 },
    );
    expect(result.stderr.length).toBeLessThan(1100);
  });

  test("still reports the exit code", async () => {
    const result = await runCommand(["sh", "-c", "exit 3"], {
      maxOutputBytes: 1000,
    });
    expect(result.exitCode).toBe(3);
  });
});

/** 新しいセッションでsleepを起動して標準出力・標準エラーを握らせたまま終了する。sleepのPIDを出力する。 */
const ESCAPE_SCRIPT =
  'const p = Bun.spawn({ cmd: ["/bin/sleep", "10"], detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" }); p.unref(); console.log(String(p.pid));';
/** ESCAPE_SCRIPTの後も先頭プロセスが終わらない。 */
const ESCAPE_AND_WAIT_SCRIPT = `${ESCAPE_SCRIPT} await Bun.sleep(10_000);`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** ESCAPE_SCRIPTが抜けさせたsleepを止める(テストの後始末)。 */
function killEscaped(stdout: string): void {
  const pid = Number(stdout.trim().split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 既に終わっている。
  }
}

describe("createBunCommandRunner process-group cleanup", () => {
  test("stops a background process the command left in its group", async () => {
    const run = createBunCommandRunner({ killGraceMs: 1_000 });
    const result = await run([
      "sh",
      "-c",
      "sleep 30 >/dev/null 2>&1 & echo $!",
    ]);
    expect(isAlive(Number(result.stdout.trim()))).toBe(false);
  });

  test("does not wait for the drain window when nothing is left", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 5_000,
      outputDrainMs: 5_000,
    });
    const start = Date.now();
    await run(["echo", "hi"]);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("does not mark an ordinary command as abandoned", async () => {
    const result = await runCommand(["echo", "hi"]);
    expect(result.outputAbandoned).toBeUndefined();
  });

  test("returns soon after exit when a process in a new session holds stdout", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 100,
      outputDrainMs: 200,
    });
    const start = Date.now();
    const result = await run([process.execPath, "-e", ESCAPE_SCRIPT]);
    killEscaped(result.stdout);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("marks the output as abandoned", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 100,
      outputDrainMs: 200,
    });
    const result = await run([process.execPath, "-e", ESCAPE_SCRIPT]);
    killEscaped(result.stdout);
    expect(result.outputAbandoned).toBe(true);
  });

  test("keeps the output read before abandoning it", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 100,
      outputDrainMs: 200,
    });
    const result = await run([process.execPath, "-e", ESCAPE_SCRIPT]);
    killEscaped(result.stdout);
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });

  test("appends the abandon note to stderr", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 100,
      outputDrainMs: 200,
    });
    const result = await run([process.execPath, "-e", ESCAPE_SCRIPT]);
    killEscaped(result.stdout);
    expect(result.stderr.endsWith(OUTPUT_ABANDONED_NOTE)).toBe(true);
  });

  test("times out a command whose escaped process holds stdout", async () => {
    const run = createBunCommandRunner({
      killGraceMs: 100,
      outputDrainMs: 200,
    });
    const start = Date.now();
    const result = await run([process.execPath, "-e", ESCAPE_AND_WAIT_SCRIPT], {
      timeoutMs: 200,
    });
    killEscaped(result.stdout);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("bounds the worst stop overhead by its parts", () => {
    expect(RUNNER_MAX_STOP_OVERHEAD_MS).toBe(13_000);
  });
});

const IMPL_BRANCH = "factory/issue-7-wi-3";
const BASE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);

describe("resolveDefaultBranchName", () => {
  test("strips refs/remotes/origin/ from refs/remotes/origin/HEAD", async () => {
    const fake = createFakeCommandRunner([ok("refs/remotes/origin/main\n")]);
    expect(
      await resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" }),
    ).toBe("main");
  });

  test("runs git symbolic-ref refs/remotes/origin/HEAD without --short", async () => {
    const fake = createFakeCommandRunner([ok("refs/remotes/origin/main\n")]);
    await resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" });
    expect(fake.calls[0]?.argv.slice(-2)).toEqual([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
  });

  test("throws when the target is not under refs/remotes/origin/", async () => {
    const fake = createFakeCommandRunner([ok("refs/remotes/upstream/main\n")]);
    await expect(
      resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" }),
    ).rejects.toThrow(/refs\/remotes\/origin\/HEAD target/);
  });

  test("throws when git fails", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: ref not a symbolic ref"),
    ]);
    await expect(
      resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" }),
    ).rejects.toThrow(/symbolic-ref/);
  });
});

describe("mergeBaseSha", () => {
  const VERIFIED_BASE_SHA = "d".repeat(40);

  test("returns the merge-base of the verified base sha and HEAD", async () => {
    const fake = createFakeCommandRunner([ok(`${BASE_SHA}\n`)]);
    expect(
      await mergeBaseSha({
        run: fake.run,
        worktreeDir: "/wt",
        baseSha: VERIFIED_BASE_SHA,
      }),
    ).toBe(BASE_SHA);
  });

  test("runs git merge-base -- <base sha> HEAD in the worktree", async () => {
    const fake = createFakeCommandRunner([ok(`${BASE_SHA}\n`)]);
    await mergeBaseSha({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: VERIFIED_BASE_SHA,
    });
    expect(fake.calls[0]?.argv.slice(-4)).toEqual([
      "merge-base",
      "--",
      VERIFIED_BASE_SHA,
      "HEAD",
    ]);
  });

  test("rejects a base that is not a sha before spawning anything", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      mergeBaseSha({
        run: fake.run,
        worktreeDir: "/wt",
        baseSha: "origin/main",
      }),
    ).rejects.toThrow(/invalid git SHA/);
  });

  test("throws when git fails", async () => {
    const fake = createFakeCommandRunner([
      fail(`fatal: Not a valid object name ${VERIFIED_BASE_SHA}`),
    ]);
    await expect(
      mergeBaseSha({
        run: fake.run,
        worktreeDir: "/wt",
        baseSha: VERIFIED_BASE_SHA,
      }),
    ).rejects.toThrow(/merge-base/);
  });
});

describe("deleteLocalBranch", () => {
  test("reports deleted: true when git succeeds", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const result = await deleteLocalBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: IMPL_BRANCH,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ deleted: true });
  });

  test("runs git branch -D -- <branch>", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await deleteLocalBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: IMPL_BRANCH,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv.slice(-4)).toEqual([
      "branch",
      "-D",
      "--",
      IMPL_BRANCH,
    ]);
  });

  test("reports deleted: false when the branch is already gone", async () => {
    const fake = createFakeCommandRunner([
      fail(`error: branch '${IMPL_BRANCH}' not found`),
    ]);
    const result = await deleteLocalBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: IMPL_BRANCH,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ deleted: false });
  });

  test("throws on any other failure", async () => {
    const fake = createFakeCommandRunner([
      fail(`error: Cannot delete branch '${IMPL_BRANCH}' checked out at '/x'`),
    ]);
    await expect(
      deleteLocalBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: IMPL_BRANCH,
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/branch -D/);
  });
});

describe("parseNumstatTotals", () => {
  test("counts every file, including a binary one", () => {
    expect(
      parseNumstatTotals("10\t2\ta.ts\n-\t-\timg.png\n2\t1\tb.ts\n").files,
    ).toBe(3);
  });

  test("sums added lines, treating a binary '-' as 0", () => {
    expect(
      parseNumstatTotals("10\t2\ta.ts\n-\t-\timg.png\n2\t1\tb.ts\n").added,
    ).toBe(12);
  });

  test("sums deleted lines", () => {
    expect(
      parseNumstatTotals("10\t2\ta.ts\n-\t-\timg.png\n2\t1\tb.ts\n").deleted,
    ).toBe(3);
  });
});

describe("removeIgnoredFiles", () => {
  test("removes ignored files only (git clean -fdX)", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await removeIgnoredFiles({ run: fake.run, worktreeDir: "/wt" });
    expect(fake.calls[0]?.argv.slice(-2)).toEqual(["clean", "-fdX"]);
  });

  test("runs with the hardening flags", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await removeIgnoredFiles({ run: fake.run, worktreeDir: "/wt" });
    expect(fake.calls[0]?.argv.slice(0, 3)).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
  });

  test("runs in the worktree", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await removeIgnoredFiles({ run: fake.run, worktreeDir: "/wt" });
    expect(fake.calls[0]?.options?.cwd).toBe("/wt");
  });

  test("never passes GH_TOKEN", async () => {
    const fake = createFakeCommandRunner([ok()]);
    await removeIgnoredFiles({ run: fake.run, worktreeDir: "/wt" });
    expect(fake.calls[0]?.options?.env?.GH_TOKEN).toBeUndefined();
  });

  test("throws when git clean fails", async () => {
    const fake = createFakeCommandRunner([fail("fatal: boom")]);
    await expect(
      removeIgnoredFiles({ run: fake.run, worktreeDir: "/wt" }),
    ).rejects.toThrow(/git clean -fdX failed/);
  });
});

/** 出力の読み取りを打ち切った結果(別セッションへ抜けたプロセスがパイプを握っていた)。 */
function abandoned(stdout: string, exitCode = 0) {
  return { ...ok(stdout), exitCode, outputAbandoned: true };
}

describe("stagedTreeSha", () => {
  test("throws when the write-tree output was abandoned", async () => {
    const fake = createFakeCommandRunner([ok(), abandoned(`${TREE_SHA}\n`)]);
    await expect(
      stagedTreeSha({ run: fake.run, worktreeDir: "/wt" }),
    ).rejects.toThrow(/write-tree.*abandoned/);
  });

  test("stages everything first", async () => {
    const fake = createFakeCommandRunner([ok(), ok(`${TREE_SHA}\n`)]);
    await stagedTreeSha({ run: fake.run, worktreeDir: "/wt" });
    expect(fake.calls[0]?.argv.slice(-2)).toEqual(["add", "-A"]);
  });

  test("returns the staged tree sha", async () => {
    const fake = createFakeCommandRunner([ok(), ok(`${TREE_SHA}\n`)]);
    expect(await stagedTreeSha({ run: fake.run, worktreeDir: "/wt" })).toBe(
      TREE_SHA,
    );
  });
});

describe("scannedTreeStopReasons", () => {
  test("returns no reason when the staged tree is the scanned tree", async () => {
    const fake = createFakeCommandRunner([ok(`${TREE_SHA}\n`)]);
    expect(
      await scannedTreeStopReasons({
        run: fake.run,
        worktreeDir: "/wt",
        scannedTreeSha: TREE_SHA,
      }),
    ).toEqual([]);
  });

  test("stops when the staged tree differs from the scanned tree", async () => {
    const fake = createFakeCommandRunner([ok(`${BASE_SHA}\n`)]);
    expect(
      await scannedTreeStopReasons({
        run: fake.run,
        worktreeDir: "/wt",
        scannedTreeSha: TREE_SHA,
      }),
    ).toEqual([WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON]);
  });

  test("reads the staged tree without staging again", async () => {
    const fake = createFakeCommandRunner([ok(`${TREE_SHA}\n`)]);
    await scannedTreeStopReasons({
      run: fake.run,
      worktreeDir: "/wt",
      scannedTreeSha: TREE_SHA,
    });
    expect(fake.calls.map((call) => call.argv.at(-1))).toEqual(["write-tree"]);
  });

  test("throws when the write-tree output was abandoned", async () => {
    const fake = createFakeCommandRunner([abandoned(`${TREE_SHA}\n`)]);
    await expect(
      scannedTreeStopReasons({
        run: fake.run,
        worktreeDir: "/wt",
        scannedTreeSha: TREE_SHA,
      }),
    ).rejects.toThrow(/write-tree.*abandoned/);
  });
});

describe("worktreeFingerprint", () => {
  test("stages everything first", async () => {
    const fake = createFakeCommandRunner([ok(), ok(`${TREE_SHA}\n`), ok("")]);
    await worktreeFingerprint({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: BASE_SHA,
    });
    expect(fake.calls[0]?.argv.slice(-2)).toEqual(["add", "-A"]);
  });

  test("returns the staged tree sha", async () => {
    const fake = createFakeCommandRunner([ok(), ok(`${TREE_SHA}\n`), ok("")]);
    const result = await worktreeFingerprint({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: BASE_SHA,
    });
    expect(result.treeSha).toBe(TREE_SHA);
  });

  test("returns the numstat totals against the base", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(`${TREE_SHA}\n`),
      ok("3\t1\ta.ts\n"),
    ]);
    const result = await worktreeFingerprint({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: BASE_SHA,
    });
    expect(result.diffStat.added).toBe(3);
  });

  test("diffs the index against the base sha without external diff drivers", async () => {
    const fake = createFakeCommandRunner([ok(), ok(`${TREE_SHA}\n`), ok("")]);
    await worktreeFingerprint({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: BASE_SHA,
    });
    expect(fake.calls[2]?.argv.slice(-7)).toEqual([
      "diff",
      "--cached",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      BASE_SHA,
      "--",
    ]);
  });

  test("throws when write-tree fails", async () => {
    const fake = createFakeCommandRunner([ok(), fail("fatal: unmerged")]);
    await expect(
      worktreeFingerprint({
        run: fake.run,
        worktreeDir: "/wt",
        baseSha: BASE_SHA,
      }),
    ).rejects.toThrow(/write-tree/);
  });

  test("throws when the numstat output was abandoned", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(`${TREE_SHA}\n`),
      abandoned("3\t1\ta.ts\n"),
    ]);
    await expect(
      worktreeFingerprint({
        run: fake.run,
        worktreeDir: "/wt",
        baseSha: BASE_SHA,
      }),
    ).rejects.toThrow(/numstat.*abandoned/);
  });
});

describe("mapDiffLineToFile", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "+const a = 1;",
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+const b = 2;",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
  ].join("\n");

  test("maps a line to the first file", () => {
    expect(mapDiffLineToFile(DIFF, 5)).toBe("src/a.ts");
  });

  test("maps a line to the second file", () => {
    expect(mapDiffLineToFile(DIFF, 11)).toBe("src/b.ts");
  });

  test("returns null for a line before any header", () => {
    expect(mapDiffLineToFile(`note\n${DIFF}`, 1)).toBeNull();
  });

  test("never names /dev/null for a deleted file", () => {
    expect(mapDiffLineToFile(DIFF, 16)).toBeNull();
  });

  test("does not take an added line that looks like a header for one", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -0,0 +1,2 @@",
      "+++ b/fake.md",
      "+secret",
    ].join("\n");
    expect(mapDiffLineToFile(diff, 6)).toBe("x.md");
  });
});

describe("mapDiffLineToFile header names", () => {
  const mapHeader = (header: string): string | null =>
    mapDiffLineToFile(
      ["diff --git a/x b/x", header, "@@ -0,0 +1 @@", "+secret"].join("\n"),
      4,
    );

  test("drops the tab git appends to a name with a space", () => {
    expect(mapHeader("+++ b/my file.txt\t")).toBe("my file.txt");
  });

  test("drops exactly one trailing tab", () => {
    expect(mapHeader("+++ b/x\t\t")).toBe("x\t");
  });

  test("unescapes a tab in a quoted name", () => {
    expect(mapHeader('+++ "b/a\\tb.txt"')).toBe("a\tb.txt");
  });

  test("unescapes a newline in a quoted name", () => {
    expect(mapHeader('+++ "b/a\\nb.txt"')).toBe("a\nb.txt");
  });

  test("unescapes quotes and backslashes in a quoted name", () => {
    expect(mapHeader('+++ "b/q\\"x\\\\y"')).toBe('q"x\\y');
  });

  test("decodes octal UTF-8 bytes in a quoted name", () => {
    expect(mapHeader('+++ "b/\\346\\227\\245.txt"')).toBe("日.txt");
  });
});

describe("dropRemovedDiffLines", () => {
  test("drops removed lines inside hunks and keeps headers and added lines", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1 +1 @@",
      "-old secret",
      "+new line",
      "--- not a header, a removed line starting with --",
    ].join("\n");
    expect(dropRemovedDiffLines(diff)).toBe(
      [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "+new line",
      ].join("\n"),
    );
  });
});

describe("formatGitleaksReport", () => {
  const DIFF = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -0,0 +1 @@",
    "+token",
  ].join("\n");

  test("lists the rule and the file mapped from the diff line per finding", () => {
    const report = JSON.stringify([
      { RuleID: "github-pat", File: "", StartLine: 5, Secret: "REDACTED" },
    ]);
    expect(formatGitleaksReport(report, DIFF)).toBe("- github-pat: a.txt");
  });

  test("says so when the line maps to no file", () => {
    const report = JSON.stringify([
      { RuleID: "github-pat", File: "", StartLine: 1, Secret: "REDACTED" },
    ]);
    expect(formatGitleaksReport(report, DIFF)).toBe(
      "- github-pat: (unknown file)",
    );
  });

  test("returns null for output that is not a JSON array", () => {
    expect(formatGitleaksReport("Error: unknown flag", DIFF)).toBeNull();
  });
});

describe("runGitleaksOnWorktree", () => {
  function configDir(): {
    factory: () => Promise<GitleaksConfigDir>;
    state: { cleaned: number };
  } {
    const state = { cleaned: 0 };
    return {
      state,
      factory: async () => ({
        path: "/tmp/fake-gitleaks",
        cleanup: async () => {
          state.cleaned += 1;
        },
      }),
    };
  }
  const TREE = `${TREE_SHA}\n`;
  const DIFF = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "-removed",
    "+token",
  ].join("\n");
  const LEAK = JSON.stringify([
    {
      RuleID: "github-pat",
      File: "",
      StartLine: 5,
      Match: "REDACTED",
      Secret: "REDACTED",
    },
  ]);
  const exit = (stdout: string, exitCode: number) => ({
    stdout,
    stderr: "",
    exitCode,
    timedOut: false,
  });
  const scan = (
    fake: ReturnType<typeof createFakeCommandRunner>,
    dir = configDir(),
  ) =>
    runGitleaksOnWorktree({
      run: fake.run,
      worktreeDir: "/wt",
      baseSha: BASE_SHA,
      timeoutMs: 1000,
      createConfigDir: dir.factory,
    });

  test("reports ok on exit 0", async () => {
    expect(
      (
        await scan(
          createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]),
        )
      ).ok,
    ).toBe(true);
  });

  test("stages everything before scanning", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[0]?.argv.slice(-2)).toEqual(["add", "-A"]);
  });

  test("writes the staged tree right after staging", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[1]?.argv.slice(-1)).toEqual(["write-tree"]);
  });

  test("returns the scanned tree sha", async () => {
    expect(
      (
        await scan(
          createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]),
        )
      ).treeSha,
    ).toBe(TREE_SHA);
  });

  test("returns the scanned tree sha with the findings", async () => {
    expect(
      (
        await scan(
          createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), exit(LEAK, 1)]),
        )
      ).treeSha,
    ).toBe(TREE_SHA);
  });

  test("throws when the write-tree output was abandoned", async () => {
    await expect(
      scan(
        createFakeCommandRunner([ok(), abandoned(TREE), ok(DIFF), ok("[]")]),
      ),
    ).rejects.toThrow(/write-tree.*abandoned/);
  });

  test("diffs the scanned tree against the base sha as text, without drivers or context", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    const argv = fake.calls[2]?.argv ?? [];
    expect(argv.slice(argv.indexOf("diff"))).toEqual([
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      BASE_SHA,
      TREE_SHA,
      "--",
    ]);
  });

  test("diffs with the hardening flags", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[2]?.argv.slice(0, 3)).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
  });

  test("caps the diff output", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[2]?.options?.maxOutputBytes).toBeGreaterThan(0);
  });

  test("throws when the diff hit the output cap", async () => {
    await expect(
      scan(
        createFakeCommandRunner([
          ok(),
          ok(TREE),
          ok(`+a${omittedMarker(10)}`),
          ok("[]"),
        ]),
      ),
    ).rejects.toThrow(/diff exceeded the scan cap/);
  });

  test("throws when the diff fails", async () => {
    await expect(
      scan(
        createFakeCommandRunner([ok(), ok(TREE), fail("fatal: bad object")]),
      ),
    ).rejects.toThrow(/git diff of the staged tree failed/);
  });

  test("throws when the diff output was abandoned", async () => {
    await expect(
      scan(
        createFakeCommandRunner([ok(), ok(TREE), abandoned(DIFF), ok("[]")]),
      ),
    ).rejects.toThrow(/git diff of the staged tree.*abandoned/);
  });

  test("throws when the gitleaks output was abandoned even on exit 0", async () => {
    await expect(
      scan(createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), abandoned("")])),
    ).rejects.toThrow(/gitleaks.*abandoned/);
  });

  test("throws when the gitleaks report was abandoned", async () => {
    await expect(
      scan(
        createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), abandoned(LEAK, 1)]),
      ),
    ).rejects.toThrow(/gitleaks.*abandoned/);
  });

  test("removes the config dir when the gitleaks output was abandoned", async () => {
    const dir = configDir();
    await scan(
      createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), abandoned("")]),
      dir,
    ).catch(() => undefined);
    expect(dir.state.cleaned).toBe(1);
  });

  test("scans stdin with the forced default config and no repository ignore file", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[3]?.argv).toEqual([
      "gitleaks",
      "stdin",
      "--redact",
      "--no-banner",
      "--no-color",
      "--log-level",
      "error",
      "--exit-code",
      "1",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--config",
      "/tmp/fake-gitleaks/gitleaks.toml",
      "--gitleaks-ignore-path",
      "/tmp/fake-gitleaks",
      "--ignore-gitleaks-allow",
    ]);
  });

  test("feeds the diff without its removed lines on stdin", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[3]?.options?.stdin).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        "+token",
      ].join("\n"),
    );
  });

  test("runs gitleaks in the private temp dir, not the worktree", async () => {
    const fake = createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]);
    await scan(fake);
    expect(fake.calls[3]?.options?.cwd).toBe("/tmp/fake-gitleaks");
  });

  test("returns the findings mapped to files (never the matched text) on exit 1", async () => {
    expect(
      (
        await scan(
          createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), exit(LEAK, 1)]),
        )
      ).output,
    ).toBe("- github-pat: a.txt");
  });

  test("reports not ok on exit 1", async () => {
    expect(
      (
        await scan(
          createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), exit(LEAK, 1)]),
        )
      ).ok,
    ).toBe(false);
  });

  test("throws when the report hit the output cap", async () => {
    await expect(
      scan(
        createFakeCommandRunner([
          ok(),
          ok(TREE),
          ok(DIFF),
          exit(`[${omittedMarker(10)}]`, 1),
        ]),
      ),
    ).rejects.toThrow(/exceeded the output cap/);
  });

  test("throws on exit 1 without a JSON report", async () => {
    await expect(
      scan(
        createFakeCommandRunner([
          ok(),
          ok(TREE),
          ok(DIFF),
          fail("Error: boom", 1),
        ]),
      ),
    ).rejects.toThrow(/gitleaks failed/);
  });

  test("throws on any other exit code (e.g. an unknown flag, 126)", async () => {
    await expect(
      scan(
        createFakeCommandRunner([
          ok(),
          ok(TREE),
          ok(DIFF),
          fail("Error: unknown flag", 126),
        ]),
      ),
    ).rejects.toThrow(/exit 126/);
  });

  test("removes the config dir afterwards", async () => {
    const dir = configDir();
    await scan(
      createFakeCommandRunner([ok(), ok(TREE), ok(DIFF), ok("[]")]),
      dir,
    );
    expect(dir.state.cleaned).toBe(1);
  });
});

// 一時ディレクトリのリポジトリで実際のgitを実行して確かめる。gitleaksだけは偽物にする。
describe("runGitleaksOnWorktree against a real git repository", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  type ScannedRepo = {
    readonly dir: string;
    readonly treeSha: string;
    readonly stdin: string;
    readonly run: CommandRunner;
    readonly git: (args: readonly string[]) => Promise<string>;
  };

  /**
   * `README.md`だけをコミットした一時リポジトリに変更を加え、検査を実行する。
   * `HOME`を一時ディレクトリに向け、システムの設定も読ませないので、利用者のgitの設定に左右されない。
   * gitleaksの実行は起動せずに、渡された標準入力を記録して「検出なし」を返す。
   */
  async function scanRepo(): Promise<ScannedRepo> {
    const root = mkdtempSync(join(tmpdir(), "gitleaks-tree-"));
    tempDirs.push(root);
    const dir = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(dir);
    mkdirSync(home);
    let stdin = "";
    const run: CommandRunner = async (argv, options) => {
      if (argv[0] === "gitleaks") {
        stdin = options?.stdin ?? "";
        return ok("[]");
      }
      return runCommand(argv, {
        ...options,
        env: {
          ...options?.env,
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    };
    const git = async (args: readonly string[]): Promise<string> => {
      const result = await run(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd: dir },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await git(["init", "-q"]);
    writeFileSync(join(dir, "README.md"), "readme\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "init"]);
    const baseSha = await git(["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "README.md"), "readme\nchanged line\n");
    writeFileSync(join(dir, "new.txt"), "added line\n");
    const scanned = await runGitleaksOnWorktree({
      run,
      worktreeDir: dir,
      baseSha,
      timeoutMs: 10_000,
    });
    return { dir, treeSha: scanned.treeSha, stdin, run, git };
  }

  test("returns the tree that git write-tree records for the staged worktree", async () => {
    const repo = await scanRepo();
    expect(repo.treeSha).toBe(await repo.git(["write-tree"]));
  });

  test("feeds the lines added in the scanned tree to gitleaks", async () => {
    const repo = await scanRepo();
    expect(repo.stdin).toContain("+added line");
  });

  test("feeds the changed lines of tracked files to gitleaks", async () => {
    const repo = await scanRepo();
    expect(repo.stdin).toContain("+changed line");
  });

  test("returns no stop reason when staging again finds the scanned tree", async () => {
    const repo = await scanRepo();
    await repo.git(["add", "-A"]);
    expect(
      await scannedTreeStopReasons({
        run: repo.run,
        worktreeDir: repo.dir,
        scannedTreeSha: repo.treeSha,
      }),
    ).toEqual([]);
  });

  test("stops the commit when a file is staged after the scan", async () => {
    const repo = await scanRepo();
    writeFileSync(join(repo.dir, "late.txt"), "written after the scan\n");
    await repo.git(["add", "-A"]);
    expect(
      await scannedTreeStopReasons({
        run: repo.run,
        worktreeDir: repo.dir,
        scannedTreeSha: repo.treeSha,
      }),
    ).toEqual([WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON]);
  });
});

describe("isReviewWorktreeOf", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";

  test("matches the path buildReviewWorktreeDir creates", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      true,
    );
  });

  test("does not match a worktree of another pr", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 421, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a worktree that is not detached", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: false })).toBe(
      false,
    );
  });

  test("does not match the same name under another directory", () => {
    const path = "/workspaces/acme/other/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a directory nested below the repo's parent", () => {
    const path = "/workspaces/acme/widgets/x/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a name whose suffix is not a 7-digit hex sha", () => {
    const path = "/workspaces/acme/widgets/review-42-abc1234-extra";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });
});

describe("git remote set-url as used by ensureFactoryClone", () => {
  test("replaces the origin URL of a real repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-clone-origin-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", dir, ...args]);
      git("init", "-q");
      git("remote", "add", "origin", "https://example.com/old/repo.git");
      const result = git(
        "remote",
        "set-url",
        "origin",
        "--",
        "https://example.com/new/repo.git",
      );
      expect([
        result.exitCode,
        git("config", "--get", "remote.origin.url").stdout.toString().trim(),
      ]).toEqual([0, "https://example.com/new/repo.git"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
