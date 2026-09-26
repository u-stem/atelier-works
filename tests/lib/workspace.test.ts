import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDetachedWorktree,
  type CommandResult,
  commitAndPush,
  createBunCommandRunner,
  createGtrWorktree,
  ensureFactoryClone,
  ensureRepo,
  fetchPrHeadRef,
  type LockFs,
  listWorktrees,
  pathExists,
  pruneWorktrees,
  readGitShowFile,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  runCommand,
  verifyWorktreeGitdir,
  withRepoLock,
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    expect(fake.calls[1]?.argv).toEqual(
      expect.arrayContaining(["checkout", "-B", "main", "origin/main"]),
    );
  });

  test("checks out -B the *configured* branch even when the existing clone was left on a different one (M7 re-gate: a prior caller defaulting to main must not stick)", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    expect(fake.calls[1]?.argv).toEqual(
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
    const fake = createFakeCommandRunner([ok(), fail("could not checkout")]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
  test("passes when the dir is registered and .git points under the repo's worktrees dir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: "/tmp/repo-worktrees/contract-smoke-branch",
        readTextFile: async () =>
          "gitdir: /tmp/repo/.git/worktrees/contract-smoke-branch\n",
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
      }),
    ).rejects.toThrow(/not registered/);
  });

  test("throws when .git points outside the expected repo's worktrees dir", async () => {
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await expect(
      verifyWorktreeGitdir({
        run: fake.run,
        repoDir: "/tmp/repo",
        dir: "/tmp/repo-worktrees/contract-smoke-branch",
        readTextFile: async () =>
          "gitdir: /somewhere/else/.git/worktrees/contract-smoke-branch\n",
      }),
    ).rejects.toThrow(/does not point under/);
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

function commitAndPushCalls(
  responses: readonly CommandResult[],
): ReturnType<typeof createFakeCommandRunner> {
  return createFakeCommandRunner(responses);
}

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
      expectedHeadSha: HEAD_SHA,
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
      expectedHeadSha: HEAD_SHA,
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
      expectedHeadSha: HEAD_SHA,
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs: createInMemoryLockFs(),
    });
    expect(result).toEqual({ outcome: "pushed", newSha });
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
      expectedHeadSha: HEAD_SHA,
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
      expectedHeadSha: HEAD_SHA,
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
        expectedHeadSha: HEAD_SHA,
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
      expectedHeadSha: HEAD_SHA,
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
        expectedHeadSha: HEAD_SHA,
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
        expectedHeadSha: "not-a-sha",
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
      expectedHeadSha: HEAD_SHA,
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
      expectedHeadSha: "abc1234",
      ghToken: "gh-token",
      verifyWorktree: noopVerify,
      lockFs,
    });

    expect(seenLockPaths).toEqual(new Set([lockPath]));
  });
});
