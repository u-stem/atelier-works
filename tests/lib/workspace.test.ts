import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addDetachedWorktree,
  assertWorktreeGitPointer,
  type CommandResult,
  commitAndPush,
  copyFileTo,
  createBunCommandRunner,
  createGtrWorktree,
  currentRemoteHeadSha,
  deleteLocalBranch,
  deleteRemoteBranch,
  ensureEmptyDir,
  ensureFactoryClone,
  ensureRepo,
  factoryCloneLockPath,
  fetchPrHeadRef,
  formatGitleaksReport,
  type GitleaksConfigDir,
  isCappedOutput,
  type LockFs,
  listWorktrees,
  mergeBaseSha,
  omittedMarker,
  parseNumstatTotals,
  pathExists,
  pruneWorktrees,
  pushNewBranch,
  readDirEntries,
  readGitShowFile,
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
  verifyWorktreeGitdir,
  WorktreeGitPointerModifiedError,
  withCommitTrailers,
  withRepoLock,
  worktreeFingerprint,
  writeTextFile,
} from "../../f/factory/lib/workspace.ts";
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

describe("createBunCommandRunner SIGTERM -> SIGKILL escalation", () => {
  test("escalates to SIGKILL after killGraceMs when the process ignores SIGTERM", async () => {
    const run = createBunCommandRunner({ killGraceMs: 30 });
    // Ignore SIGTERM so the process only dies via the SIGKILL escalation.
    const result = await run(["sh", "-c", "trap '' TERM; sleep 5"], {
      timeoutMs: 30,
    });
    expect(result.timedOut).toBe(true);
  });

  test("does not send SIGKILL when the process exits promptly on SIGTERM", async () => {
    const run = createBunCommandRunner({ killGraceMs: 5_000 });
    const start = Date.now();
    await run(["sleep", "5"], { timeoutMs: 30 });
    // If SIGKILL's 5s grace timer had to fire, this would take >5s; a
    // process that dies immediately on SIGTERM should return well under it.
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
      mtimeMs: async () => virtualNowMs, // always "just touched" -> never stale
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
        // Simulate another process reclaiming the lock (different token)
        // while we were still "running" fn().
        store.set(
          "/tmp/reclaimed.lock",
          JSON.stringify({ token: "someone-else" }),
        );
      },
    });

    expect(removeCalls).toBe(0);
  });

  // Real bug (E2E, post-launch fix): `ensureFactoryClone`'s lock path's
  // parent dir (e.g. `/workspaces/factory/`) doesn't exist yet on a
  // container's first-ever run, before the clone that would create it —
  // `tryCreate`'s real `open(path, "wx")` then fails with `ENOENT`
  // (`pipeline_prepare` crashed on this in E2E), which the lock's own
  // "already locked" retry logic only ever expected to be `EEXIST`.
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

  test("resets credential.helper and disables hooks/fsmonitor on every call", async () => {
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

  // Re-gate fix (adopted, High): `-c core.symlinks=false` on
  // `addDetachedWorktree`'s `worktree add` (and the `GIT_CONFIG_*` on `git
  // gtr new`) only applies to that ONE invocation — every later operation
  // on the same repo (`git status`, `add -A`, `commit`, and critically the
  // gtr-reuse `reset --hard`) runs with git's default `core.symlinks=true`
  // unless the setting is persisted into the main clone's config, which
  // every worktree of it shares.
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

describe("factoryCloneLockPath", () => {
  test("is the sibling <dir>.lock file, not the worktree helpers' lock", () => {
    // Arrange
    const dir = "/workspaces/factory/atelier-works";
    // Act
    const lockPath = factoryCloneLockPath(dir);
    // Assert
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

  test("clones with --branch <branch> --single-branch (M7 factory_branch, required — no default)", async () => {
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
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
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
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["fetch", "origin", "--", "main"]),
    );
    expect(fake.calls[2]?.argv).toEqual(
      expect.arrayContaining(["checkout", "-B", "main", "origin/main"]),
    );
  });

  test("discards local modifications (reset --hard) between fetch and checkout -B", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "main",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.argv).toEqual(
      expect.arrayContaining(["reset", "--hard"]),
    );
  });

  test("checks out -B the *configured* branch even when the existing clone was left on a different one (M7 re-gate: a prior caller defaulting to main must not stick)", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      branch: "feat/factory-foundation",
      exists: async () => true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining([
        "fetch",
        "origin",
        "--",
        "feat/factory-foundation",
      ]),
    );
    expect(fake.calls[2]?.argv).toEqual(
      expect.arrayContaining([
        "checkout",
        "-B",
        "feat/factory-foundation",
        "origin/feat/factory-foundation",
      ]),
    );
  });

  test("throws when the fetch fails", async () => {
    const fake = createFakeCommandRunner([fail("could not fetch")]);
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

  test("throws when the checkout fails", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
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
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
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

describe("removeWorktree", () => {
  test("includes --force when requested", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    await removeWorktree({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      force: true,
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv).toContain("--force");
  });

  test("puts -- before the worktree dir", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    await removeWorktree({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      lockFs: createInMemoryLockFs(),
    });
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv.at(-2)).toBe("--");
  });

  test("prunes after removing", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
    await removeWorktree({
      run: fake.run,
      repoDir: "/repo",
      dir: "/repo/wt",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.argv).toContain("prune");
  });

  test("is serialized under the same lock path ensureRepo would use for this repo", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = createFakeCommandRunner([
      {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: "", stderr: "", exitCode: 0, timedOut: false },
    ]);
    // Peek at the lock file mid-flight via a wrapping run that checks the lock exists.
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/repo/main.lock")) !== null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await removeWorktree({
      run: runAndCheck,
      repoDir: "/repo/main",
      dir: "/repo/main-wt",
      lockFs,
    });
    expect(sawLockDuringRun).toBe(true);
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

// Real `git worktree list --porcelain` output captured during the M4
// contract smoke (spec-cycle2.md §7 item 14), paths genericized.
const REAL_WORKTREE_PORCELAIN = [
  "worktree /tmp/repo",
  "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
  "branch refs/heads/main",
  "",
  "worktree /tmp/repo-worktrees/contract-smoke-branch",
  "HEAD c4c85336fb74d3bc13cca578c870a39583722c58",
  "branch refs/heads/contract-smoke-branch",
  "",
].join("\n");

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

  test("parses bare and detached markers", async () => {
    const porcelain = [
      "worktree /repo",
      "bare",
      "",
      "worktree /repo/wt",
      "HEAD deadbeef",
      "detached",
      "",
    ].join("\n");
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

describe("createGtrWorktree", () => {
  test("reuses an existing worktree whose branch matches", async () => {
    const fake = createFakeCommandRunner([
      ok(REAL_WORKTREE_PORCELAIN),
      ok(),
      ok(),
      ok(),
    ]);
    const result = await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "contract-smoke-branch",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result.hookStatus).toBe("reused");
  });

  test("does not call `git gtr new` when reusing", async () => {
    const fake = createFakeCommandRunner([
      ok(REAL_WORKTREE_PORCELAIN),
      ok(),
      ok(),
      ok(),
    ]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "contract-smoke-branch",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls.some((call) => call.argv.includes("gtr"))).toBe(false);
  });

  // devil-advocate fix (adopted, fatal): a previous round's timed-out /
  // cancelled Claude run can leave stray edits sitting in a reused
  // worktree; without resetting to the branch's current remote state first,
  // those stray edits would get swept into the *next* round's `git add -A`
  // (commitAndPush), and — if a human had since pushed to the branch
  // directly — the reused worktree's stale local history would also make
  // the next push non-fast-forward. Reusing a worktree now fetches, hard-
  // resets, and cleans it back to a pristine `origin/<branch>` state before
  // handing it back. New worktrees (via `git gtr new`) don't need this:
  // they're freshly created from the current remote state already.
  describe("reuse path: fetch -> reset --hard -> clean (fixes stale-worktree bug)", () => {
    test("fetches origin/<branch> first", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      });
      const argv = fake.calls[1]?.argv ?? [];
      expect(argv).toEqual(
        expect.arrayContaining([
          "fetch",
          "origin",
          "--",
          "contract-smoke-branch",
        ]),
      );
    });

    test("then resets --hard to origin/<branch>", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      });
      const argv = fake.calls[2]?.argv ?? [];
      expect(argv).toEqual(
        expect.arrayContaining([
          "reset",
          "--hard",
          "origin/contract-smoke-branch",
        ]),
      );
    });

    test("then cleans untracked files", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      });
      const argv = fake.calls[3]?.argv ?? [];
      expect(argv).toEqual(expect.arrayContaining(["clean", "-fd"]));
    });

    test("does not put -- before the ref for reset --hard (same rev-parse-like exception as elsewhere)", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      });
      const argv = fake.calls[2]?.argv ?? [];
      expect(argv).not.toContain("--");
    });

    test("resets and cleans in the worktree dir, not repoDir", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        ok(),
        ok(),
      ]);
      await createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "contract-smoke-branch",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      });
      expect([
        fake.calls[2]?.options?.cwd,
        fake.calls[3]?.options?.cwd,
      ]).toEqual([
        "/tmp/repo-worktrees/contract-smoke-branch",
        "/tmp/repo-worktrees/contract-smoke-branch",
      ]);
    });

    test("throws a masked error when the reset fails", async () => {
      const fake = createFakeCommandRunner([
        ok(REAL_WORKTREE_PORCELAIN),
        ok(),
        fail("fatal: could not reset"),
      ]);
      await expect(
        createGtrWorktree({
          run: fake.run,
          repoDir: "/repo",
          branch: "contract-smoke-branch",
          ghToken: "gh-token",
          lockFs: createInMemoryLockFs(),
        }),
      ).rejects.toThrow(/reset --hard/);
    });
  });

  test("parses a real captured `git gtr new --porcelain` sample when creating", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([ok(""), ok(gtrPorcelain)]);
    const result = await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({
      path: "/tmp/repo-worktrees/new-branch",
      branch: "new-branch",
      hookStatus: "none",
    });
  });

  test("rejects a branch name starting with a dash", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      createGtrWorktree({
        run: fake.run,
        repoDir: "/repo",
        branch: "-evil",
        ghToken: "gh-token",
      }),
    ).rejects.toThrow();
  });

  test("passes core.symlinks=false to git gtr new via GIT_CONFIG_* env vars (gtr's own argv can't carry -c)", async () => {
    const gtrPorcelain =
      "path\t/tmp/repo-worktrees/new-branch\nbranch\tnew-branch\nhook_status\tnone\n";
    const fake = createFakeCommandRunner([ok(""), ok(gtrPorcelain)]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "new-branch",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    const env = fake.calls[1]?.options?.env ?? {};
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.symlinks");
    expect(env.GIT_CONFIG_VALUE_0).toBe("false");
  });
});

describe("verifyWorktreeGitdir", () => {
  const WT = "/tmp/repo-worktrees/contract-smoke-branch";
  const GITDIR = "/tmp/repo/.git/worktrees/contract-smoke-branch";
  // realpath stand-in: normalizes `..` like the real one (no symlinks here).
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

describe("resolveDefaultBranchHeadSha", () => {
  test("returns the trimmed sha origin/HEAD points to", async () => {
    const fake = createFakeCommandRunner([
      ok("2222222222222222222222222222222222222c\n"),
    ]);
    const sha = await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    expect(sha).toBe("2222222222222222222222222222222222222c");
  });

  test("runs git rev-parse --verify origin/HEAD without -- (rev-parse exception)", async () => {
    const fake = createFakeCommandRunner([ok("abc\n")]);
    await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["rev-parse", "--verify", "origin/HEAD"]),
    );
    expect(argv).not.toContain("--");
  });

  test("does not include GH_TOKEN in env (local-only, no network)", async () => {
    const fake = createFakeCommandRunner([ok("abc\n")]);
    await resolveDefaultBranchHeadSha(fake.run, "/repo/main");
    const env = fake.calls[0]?.options?.env ?? {};
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  test("throws a masked error when rev-parse fails", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: ambiguous argument 'origin/HEAD': unknown revision"),
    ]);
    await expect(
      resolveDefaultBranchHeadSha(fake.run, "/repo/main"),
    ).rejects.toThrow(/origin\/HEAD/);
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
      ok("fix/branch\n"), // rev-parse --abbrev-ref HEAD
      ok(), // fetch origin fix/branch
      ok(`${OTHER_SHA}\n`), // rev-parse --verify origin/fix/branch
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

  test("returns nothing_to_commit when the working tree is clean", async () => {
    const fake = commitAndPushCalls([
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(), // git add -A
      ok(""), // git status --porcelain (empty = clean)
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
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(), // git push
      ok(`${newSha}\n`), // rev-parse --verify HEAD
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

  test("the git commit call's env carries GIT_AUTHOR_EMAIL from the given author", async () => {
    const fake = commitAndPushCalls([
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(), // git push
      ok(`${HEAD_SHA}\n`), // rev-parse --verify HEAD
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
      ok("fix/branch\n"), // rev-parse --abbrev-ref HEAD
      ok(), // fetch origin fix/branch
      ok(`${HEAD_SHA}\n`), // rev-parse --verify origin/fix/branch (matches expectedHeadSha)
      ok(), // git add -A
      ok(" M file.ts\n"), // git status --porcelain
      ok(), // git commit
      fail(
        "! [rejected]        fix/branch -> fix/branch (fetch first)\nerror: failed to push some refs",
      ), // git push
      ok(), // re-fetch origin fix/branch after rejection
      ok(`${raceSha}\n`), // rev-parse --verify origin/fix/branch after rejection
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
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
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
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
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
      ok("fix/branch\n"),
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
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
      ok(),
      ok(`${HEAD_SHA}\n`),
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
    const pushCallEnv = fake.calls[6]?.options?.env; // git push
    expect([commitCallEnv?.GH_TOKEN, pushCallEnv?.GH_TOKEN]).toEqual([
      undefined,
      "gh-secret",
    ]);
  });

  test("the commit message (argv) carries the Claude co-author and Generated-By trailers", async () => {
    const fake = commitAndPushCalls([
      ok("fix/branch\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(), // git commit
      ok(), // git push
      ok(`${HEAD_SHA}\n`),
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
      ok("factory/issue-7-wi-3\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
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
      ok("main\n"),
      ok(),
      ok(`${HEAD_SHA}\n`),
      ok(),
      ok(" M file.ts\n"),
      ok(),
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
        ok("fix/branch\n"),
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
  const LS_REMOTE_HIT = `${HEAD_SHA}\trefs/heads/${BRANCH}\n`;

  test("pushes the branch when the remote does not have it yet", async () => {
    const fake = createFakeCommandRunner([
      fail("", 2), // ls-remote --exit-code: no matching ref
      ok(), // git push -u origin -- <branch>
    ]);
    const result = await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ pushed: true });
  });

  test("asks the remote with git ls-remote --exit-code --heads origin -- <branch>", async () => {
    const fake = createFakeCommandRunner([fail("", 2), ok()]);
    await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[0]?.argv.slice(-6)).toEqual([
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      "--",
      BRANCH,
    ]);
  });

  test("runs git push -u origin -- <branch>", async () => {
    const fake = createFakeCommandRunner([fail("", 2), ok()]);
    await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls[1]?.argv).toEqual(
      expect.arrayContaining(["push", "-u", "origin", "--", BRANCH]),
    );
  });

  test("both the ls-remote and the push run in repoDir", async () => {
    const fake = createFakeCommandRunner([fail("", 2), ok()]);
    await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect([fake.calls[0]?.options?.cwd, fake.calls[1]?.options?.cwd]).toEqual([
      "/repo/main",
      "/repo/main",
    ]);
  });

  test("is a no-op when the remote already has the branch", async () => {
    const fake = createFakeCommandRunner([ok(LS_REMOTE_HIT)]);
    const result = await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ pushed: false });
  });

  test("does not call git push when the remote already has the branch", async () => {
    const fake = createFakeCommandRunner([ok(LS_REMOTE_HIT)]);
    await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls).toHaveLength(1);
  });

  test("both network calls (ls-remote and push) carry GH_TOKEN", async () => {
    const fake = createFakeCommandRunner([fail("", 2), ok()]);
    await pushNewBranch({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-secret",
      lockFs: createInMemoryLockFs(),
    });
    expect([
      fake.calls[0]?.options?.env?.GH_TOKEN,
      fake.calls[1]?.options?.env?.GH_TOKEN,
    ]).toEqual(["gh-secret", "gh-secret"]);
  });

  test("throws a masked error when the push fails", async () => {
    const fake = createFakeCommandRunner([
      fail("", 2),
      fail("remote: Permission to acme/widgets.git denied to factory-bot."),
    ]);
    await expect(
      pushNewBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: BRANCH,
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/git push -u origin factory\/issue-7-wi-3 failed/);
  });

  test("throws when ls-remote fails with anything other than exit 2", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: could not read from remote repository", 128),
    ]);
    await expect(
      pushNewBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: BRANCH,
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/ls-remote/);
  });

  test("rejects an invalid branch name before spawning anything", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      pushNewBranch({
        run: fake.run,
        repoDir: "/repo/main",
        branch: "-evil",
        ghToken: "gh-token",
        lockFs: createInMemoryLockFs(),
      }),
    ).rejects.toThrow(/invalid branch name/);
  });

  test("is serialized under the same lock path other repo-tree git ops use", async () => {
    const lockFs = createInMemoryLockFs();
    let sawLockDuringRun = false;
    const fake = createFakeCommandRunner([fail("", 2), ok()]);
    const runAndCheck: typeof fake.run = async (argv, options) => {
      sawLockDuringRun =
        (await lockFs.read("/repo/main.lock")) !== null || sawLockDuringRun;
      return fake.run(argv, options);
    };
    await pushNewBranch({
      run: runAndCheck,
      repoDir: "/repo/main",
      branch: BRANCH,
      ghToken: "gh-token",
      lockFs,
    });
    expect(sawLockDuringRun).toBe(true);
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

describe("currentRemoteHeadSha", () => {
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

  test("returns null when origin/<branch> is not resolvable", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: Needed a single revision"),
    ]);
    const sha = await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(sha).toBeNull();
  });

  test("runs git rev-parse --verify origin/<branch> without -- (rev-parse exception)", async () => {
    const fake = createFakeCommandRunner([ok(`${HEAD_SHA}\n`)]);
    await currentRemoteHeadSha({
      run: fake.run,
      repoDir: "/repo/main",
      branch: BRANCH,
    });
    expect(fake.calls[0]?.argv).not.toContain("--");
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

const IMPL_BRANCH = "factory/issue-7-wi-3";
const BASE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);

describe("resolveDefaultBranchName", () => {
  test("strips origin/ from refs/remotes/origin/HEAD", async () => {
    const fake = createFakeCommandRunner([ok("origin/main\n")]);
    expect(
      await resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" }),
    ).toBe("main");
  });

  test("runs git symbolic-ref --short refs/remotes/origin/HEAD", async () => {
    const fake = createFakeCommandRunner([ok("origin/main\n")]);
    await resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" });
    expect(fake.calls[0]?.argv.slice(-3)).toEqual([
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
  });

  test("throws when the target is not under origin/", async () => {
    const fake = createFakeCommandRunner([ok("upstream/main\n")]);
    await expect(
      resolveDefaultBranchName({ run: fake.run, repoDir: "/repo/main" }),
    ).rejects.toThrow(/origin\/HEAD/);
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
  test("returns the merge-base of origin/<base> and HEAD", async () => {
    const fake = createFakeCommandRunner([ok(`${BASE_SHA}\n`)]);
    expect(
      await mergeBaseSha({
        run: fake.run,
        worktreeDir: "/wt",
        baseBranch: "main",
      }),
    ).toBe(BASE_SHA);
  });

  test("runs git merge-base origin/<base> HEAD in the worktree", async () => {
    const fake = createFakeCommandRunner([ok(`${BASE_SHA}\n`)]);
    await mergeBaseSha({
      run: fake.run,
      worktreeDir: "/wt",
      baseBranch: "main",
    });
    expect(fake.calls[0]?.argv.slice(-4)).toEqual([
      "merge-base",
      "--",
      "origin/main",
      "HEAD",
    ]);
  });

  test("throws when git fails", async () => {
    const fake = createFakeCommandRunner([
      fail("fatal: Not a valid object name origin/main"),
    ]);
    await expect(
      mergeBaseSha({ run: fake.run, worktreeDir: "/wt", baseBranch: "main" }),
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
});

describe("formatGitleaksReport", () => {
  test("lists rule, file and line per finding", () => {
    const report = JSON.stringify([
      { RuleID: "github-pat", File: "a.txt", StartLine: 3, Secret: "REDACTED" },
    ]);
    expect(formatGitleaksReport(report)).toBe("- github-pat: a.txt:3");
  });

  test("returns null for output that is not a JSON array", () => {
    expect(formatGitleaksReport("Error: unknown flag")).toBeNull();
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
  const LEAK = JSON.stringify([
    {
      RuleID: "github-pat",
      File: "a.txt",
      StartLine: 3,
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
      timeoutMs: 1000,
      createConfigDir: dir.factory,
    });

  test("reports ok on exit 0", async () => {
    expect((await scan(createFakeCommandRunner([ok(), ok("[]")]))).ok).toBe(
      true,
    );
  });

  test("stages everything before scanning", async () => {
    const fake = createFakeCommandRunner([ok(), ok("[]")]);
    await scan(fake);
    expect(fake.calls[0]?.argv.slice(-2)).toEqual(["add", "-A"]);
  });

  test("scans staged changes with the forced default config and the worktree as positional argument", async () => {
    const fake = createFakeCommandRunner([ok(), ok("[]")]);
    await scan(fake);
    expect(fake.calls[1]?.argv).toEqual([
      "gitleaks",
      "git",
      "--staged",
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
      "/wt",
    ]);
  });

  test("returns the findings (never the matched text) on exit 1", async () => {
    expect(
      (await scan(createFakeCommandRunner([ok(), exit(LEAK, 1)]))).output,
    ).toBe("- github-pat: a.txt:3");
  });

  test("reports not ok on exit 1", async () => {
    expect(
      (await scan(createFakeCommandRunner([ok(), exit(LEAK, 1)]))).ok,
    ).toBe(false);
  });

  test("throws when the report hit the output cap", async () => {
    await expect(
      scan(createFakeCommandRunner([ok(), exit(`[${omittedMarker(10)}]`, 1)])),
    ).rejects.toThrow(/exceeded the output cap/);
  });

  test("throws on exit 1 without a JSON report", async () => {
    await expect(
      scan(createFakeCommandRunner([ok(), fail("Error: boom", 1)])),
    ).rejects.toThrow(/gitleaks failed/);
  });

  test("throws on any other exit code (e.g. an unknown flag, 126)", async () => {
    await expect(
      scan(createFakeCommandRunner([ok(), fail("Error: unknown flag", 126)])),
    ).rejects.toThrow(/exit 126/);
  });

  test("removes the config dir afterwards", async () => {
    const dir = configDir();
    await scan(createFakeCommandRunner([ok(), ok("[]")]), dir);
    expect(dir.state.cleaned).toBe(1);
  });
});
