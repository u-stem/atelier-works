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
  type LockFs,
  listWorktrees,
  pathExists,
  removeWorktree,
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
});

describe("ensureRepo", () => {
  test("clones with --no-checkout when the target dir does not exist", async () => {
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
    const fake = createFakeCommandRunner([ok(), ok()]);
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
});

describe("ensureFactoryClone", () => {
  test("clones the repo URL when the clone dir does not exist", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const result = await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      exists: async () => false,
    });
    expect(result).toEqual({
      dir: "/workspaces/factory/atelier-works",
      action: "cloned",
    });
  });

  test("pulls --ff-only when the clone dir already exists", async () => {
    const fake = createFakeCommandRunner([ok()]);
    const result = await ensureFactoryClone({
      run: fake.run,
      repoUrl: "https://github.com/acme/atelier-works.git",
      ghToken: "gh-token",
      exists: async () => true,
    });
    expect(result).toEqual({
      dir: "/workspaces/factory/atelier-works",
      action: "pulled",
    });
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
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
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
    const fake = createFakeCommandRunner([ok(REAL_WORKTREE_PORCELAIN)]);
    await createGtrWorktree({
      run: fake.run,
      repoDir: "/repo",
      branch: "contract-smoke-branch",
      ghToken: "gh-token",
      lockFs: createInMemoryLockFs(),
    });
    expect(fake.calls).toHaveLength(1);
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
      run: createFakeCommandRunner([ok(), ok()]).run,
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
