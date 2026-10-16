import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  CommitBlockedError,
  type LockFs,
  type MergeBaseResult,
  mergeBaseIntoWorktree,
  readWorktreeGitPointer,
  runCommand,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";
import { type FakeCall, fail, ok } from "./testSupport.ts";

const PR_HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const AUTO = "c".repeat(40);
const TREE = "d".repeat(40);
const BLOB_BASE = "e".repeat(40);
const BLOB_OURS = "f".repeat(40);
const BLOB_THEIRS = "1".repeat(40);
const AUTHOR = { name: "factory-bot", email: "bot@example.invalid" };
const POINTER = "gitdir: /repo/.git/worktrees/wt\n";

function createInMemoryLockFs(): LockFs {
  const store = new Map<string, string>();
  return {
    tryCreate: async (lockPath, content) => {
      if (store.has(lockPath)) return false;
      store.set(lockPath, content);
      return true;
    },
    read: async (lockPath) => store.get(lockPath) ?? null,
    mtimeMs: async () => 0,
    remove: async (lockPath) => {
      store.delete(lockPath);
    },
  };
}

/** `git`の後ろの、`-c <key>=<value>`と`--literal-pathspecs`を読み飛ばした最初の語。 */
function subcommandOf(argv: readonly string[]): string {
  let index = 1;
  for (;;) {
    const word = argv[index];
    if (word === "-c") index += 2;
    else if (word === "--literal-pathspecs") index += 1;
    else return word ?? "";
  }
}

type Responder = (argv: readonly string[]) => CommandResult;

function unmerged(paths: readonly string[]): string {
  return paths
    .map(
      (path) =>
        `100644 ${BLOB_BASE} 1\t${path}\u0000100644 ${BLOB_OURS} 2\t${path}\u0000100644 ${BLOB_THEIRS} 3\t${path}\u0000`,
    )
    .join("");
}

/**
 * `mergeBaseIntoWorktree`が1つの競合を見つける場面を、gitの副コマンドごとの応答で表す偽のrunner。
 * `over`で副コマンドごとに応答を差し替える。
 */
function scenario(over: Record<string, Responder> = {}): {
  readonly run: CommandRunner;
  readonly calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let committed = false;
  const defaults: Record<string, Responder> = {
    "symbolic-ref": () => ok("refs/heads/fix/branch\n"),
    status: () => ok(""),
    clean: () => ok(),
    "rev-parse": (argv) => {
      if (argv.includes("--verify")) {
        if (argv.includes("HEAD")) return ok(`${committed ? AUTO : PR_HEAD}\n`);
        return ok(`${BASE}\n`);
      }
      return ok(`${AUTO}\n${PR_HEAD}\n${BASE}\n${TREE}\n`);
    },
    "ls-remote": () =>
      ok(
        `ref: refs/heads/main\tHEAD\n${BASE}\tHEAD\n${BASE}\trefs/heads/main\n`,
      ),
    fetch: () => ok(),
    "merge-base": () => fail("", 1),
    merge: (argv) =>
      argv.includes("--abort") ? ok() : fail("CONFLICT (content)", 1),
    "ls-files": (argv) =>
      argv.includes("-u") ? ok(unmerged(["src/a.ts"])) : ok(""),
    diff: () => ok("1\t1\tsrc/a.ts\0"),
    "check-attr": () => ok(""),
    "cat-file": () => ok("const a = 1;\n"),
    add: () => ok(),
    commit: () => {
      committed = true;
      return ok();
    },
  };
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    const handler = over[subcommandOf(argv)] ?? defaults[subcommandOf(argv)];
    if (handler === undefined) {
      throw new Error(`scenario: unexpected git call ${argv.join(" ")}`);
    }
    return handler(argv);
  };
  return { run, calls };
}

const noopVerify = async (): Promise<void> => {};

function mergeOptions(
  run: CommandRunner,
  extra: Partial<Parameters<typeof mergeBaseIntoWorktree>[0]> = {},
): Parameters<typeof mergeBaseIntoWorktree>[0] {
  return {
    run,
    repoDir: "/repo",
    dir: "/repo/wt",
    branch: "fix/branch",
    worktreeGitPointer: POINTER,
    prHeadSha: PR_HEAD,
    baseBranch: "main",
    author: AUTHOR,
    ghToken: "gh-secret",
    verifyWorktree: noopVerify,
    pointerFs: {
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
      readFile: async () => POINTER,
    },
    lockFs: createInMemoryLockFs(),
    ...extra,
  };
}

function callsOf(
  calls: readonly FakeCall[],
  subcommand: string,
): readonly FakeCall[] {
  return calls.filter((call) => subcommandOf(call.argv) === subcommand);
}

describe("mergeBaseIntoWorktree argv", () => {
  test("every git call carries --literal-pathspecs", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const without = fake.calls.filter(
      (call) => !call.argv.includes("--literal-pathspecs"),
    );
    expect(without).toEqual([]);
  });

  test("merges the base sha with diff3 style, rerere off and renormalize off", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const argv = callsOf(fake.calls, "merge").find(
      (call) => !call.argv.includes("--abort"),
    )?.argv;
    const tail = argv?.slice(argv.indexOf("--literal-pathspecs"));
    expect(tail).toEqual([
      "--literal-pathspecs",
      "-c",
      "merge.conflictStyle=diff3",
      "-c",
      "rerere.enabled=false",
      "-c",
      "merge.renormalize=false",
      "merge",
      "--no-ff",
      "--no-commit",
      "--",
      BASE,
    ]);
  });

  test("fetches the base by its sha without recursing into submodules", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const argv = callsOf(fake.calls, "fetch")[0]?.argv ?? [];
    expect(argv.slice(argv.indexOf("fetch"))).toEqual([
      "fetch",
      "--no-recurse-submodules",
      "origin",
      "--",
      BASE,
    ]);
  });

  test("stages only the conflicted paths, never everything", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const argv = callsOf(fake.calls, "add")[0]?.argv ?? [];
    expect(argv.slice(argv.indexOf("add"))).toEqual(["add", "--", "src/a.ts"]);
  });

  test("passes the token only to ls-remote and fetch", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const withToken = fake.calls
      .filter((call) => call.options?.env?.GH_TOKEN === "gh-secret")
      .map((call) => subcommandOf(call.argv));
    expect(withToken.sort()).toEqual(["fetch", "ls-remote"]);
  });

  test("lists the unmerged entries, then checks for untracked files", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const listed = callsOf(fake.calls, "ls-files").map((call) =>
      call.argv.slice(call.argv.indexOf("ls-files")).join(" "),
    );
    expect(listed).toEqual([
      "ls-files -u -z",
      "ls-files -o --exclude-standard -z",
    ]);
  });
});

describe("mergeBaseIntoWorktree result", () => {
  test("returns the baseline commit with its parents checked", async () => {
    const fake = scenario();
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result).toEqual({
      outcome: "merged",
      baseSha: BASE,
      autoSha: AUTO,
      autoTreeSha: TREE,
      conflictedPaths: ["src/a.ts"],
      conflictBlobs: [
        {
          path: "src/a.ts",
          baseBlob: BLOB_BASE,
          oursBlob: BLOB_OURS,
          theirsBlob: BLOB_THEIRS,
        },
      ],
    });
  });

  test("returns up_to_date without merging when the base is an ancestor of the PR head", async () => {
    const fake = scenario({ "merge-base": () => ok() });
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result).toEqual({ outcome: "up_to_date", baseSha: BASE });
  });

  test("does not run merge when up to date", async () => {
    const fake = scenario({ "merge-base": () => ok() });
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(callsOf(fake.calls, "merge")).toEqual([]);
  });

  test("returns base_not_default when the remote HEAD is another branch", async () => {
    const fake = scenario({
      "ls-remote": () =>
        ok(
          `ref: refs/heads/trunk\tHEAD\n${BASE}\tHEAD\n${BASE}\trefs/heads/main\n`,
        ),
    });
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result).toEqual({ outcome: "base_not_default" });
  });

  test("does not fetch when the base is not the default branch", async () => {
    const fake = scenario({
      "ls-remote": () =>
        ok(`ref: refs/heads/trunk\tHEAD\n${BASE}\trefs/heads/main\n`),
    });
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(callsOf(fake.calls, "fetch")).toEqual([]);
  });

  test("ignores a ref that only ends with the branch name", async () => {
    const decoy = "9".repeat(40);
    const fake = scenario({
      "ls-remote": () =>
        ok(
          `ref: refs/heads/main\tHEAD\n${decoy}\trefs/heads/x/refs/heads/main\n${BASE}\trefs/heads/main\n`,
        ),
    });
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result).toMatchObject({ baseSha: BASE });
  });

  test("merges without conflicts and records no conflicted path", async () => {
    const fake = scenario({
      merge: () => ok("Merge made by the 'ort' strategy."),
      "ls-files": () => ok(""),
    });
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result).toMatchObject({ outcome: "merged", conflictedPaths: [] });
  });

  test("does not run add when nothing conflicts", async () => {
    const fake = scenario({
      merge: () => ok(),
      "ls-files": () => ok(""),
    });
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(callsOf(fake.calls, "add")).toEqual([]);
  });
});

describe("mergeBaseIntoWorktree unresolvable", () => {
  async function reasonOf(
    over: Record<string, Responder>,
  ): Promise<MergeBaseResult> {
    return mergeBaseIntoWorktree(mergeOptions(scenario(over).run));
  }

  test("more than 10 conflicted paths", async () => {
    const paths = Array.from({ length: 11 }, (_, i) => `src/f${String(i)}.ts`);
    const result = await reasonOf({
      "ls-files": () => ok(unmerged(paths)),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "too_many_conflicts",
    });
  });

  test("exactly 10 conflicted paths is accepted", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/f${String(i)}.ts`);
    const fake = scenario({
      "ls-files": (argv) =>
        argv.includes("-u") ? ok(unmerged(paths)) : ok(""),
      diff: () => ok(paths.map((path) => `1\t1\t${path}\0`).join("")),
    });
    const result = await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(result.outcome).toBe("merged");
  });

  test("a symlink among the conflicted paths", async () => {
    const result = await reasonOf({
      "ls-files": () =>
        ok(
          `120000 ${BLOB_BASE} 1\tlink\u0000120000 ${BLOB_OURS} 2\tlink\u0000120000 ${BLOB_THEIRS} 3\tlink\0`,
        ),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "not_regular_file",
    });
  });

  test("a submodule among the conflicted paths", async () => {
    const result = await reasonOf({
      "ls-files": () =>
        ok(
          `160000 ${BLOB_BASE} 1\tmod\u0000160000 ${BLOB_OURS} 2\tmod\u0000160000 ${BLOB_THEIRS} 3\tmod\0`,
        ),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "not_regular_file",
    });
  });

  test("a delete/modify conflict without all three stages", async () => {
    const result = await reasonOf({
      "ls-files": () =>
        ok(`100644 ${BLOB_BASE} 1\ta.ts\u0000100644 ${BLOB_OURS} 2\ta.ts\0`),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "missing_stage",
    });
  });

  test("a path that is not a safe repository path", async () => {
    const result = await reasonOf({
      "ls-files": () => ok(unmerged([".git/hooks/post-merge"])),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "unsafe_path",
    });
  });

  test("a binary file", async () => {
    const result = await reasonOf({ diff: () => ok("-\t-\tsrc/a.ts\0") });
    expect(result).toEqual({ outcome: "unresolvable", reason: "binary" });
  });

  test("a file with a merge attribute in the PR head tree", async () => {
    const result = await reasonOf({
      "check-attr": (argv) =>
        argv.includes(`--source=${PR_HEAD}`)
          ? ok("src/a.ts\0merge\0custom\0")
          : ok(""),
    });
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("a file with a filter attribute in the base tree", async () => {
    const result = await reasonOf({
      "check-attr": (argv) =>
        argv.includes(`--source=${BASE}`)
          ? ok("src/a.ts\0filter\0lfs\0")
          : ok(""),
    });
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("a file with a working-tree-encoding attribute", async () => {
    const result = await reasonOf({
      "check-attr": () => ok("src/a.ts\0working-tree-encoding\0utf-16\0"),
    });
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("a file with an ident attribute", async () => {
    const result = await reasonOf({
      "check-attr": () => ok("src/a.ts\0ident\0set\0"),
    });
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("a file with a diff attribute", async () => {
    const result = await reasonOf({
      "check-attr": () => ok("src/a.ts\0diff\0custom\0"),
    });
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("an attribute that does not change the merge is accepted", async () => {
    const result = await reasonOf({
      "check-attr": () => ok("src/a.ts\0linguist-generated\0set\0"),
    });
    expect(result.outcome).toBe("merged");
  });

  test("a marker-like line in the PR head file", async () => {
    const result = await reasonOf({
      "cat-file": (argv) =>
        argv.includes(BLOB_OURS)
          ? ok("a\n<<<<<<< HEAD\nb\n")
          : ok("const a = 1;\n"),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "marker_like_line",
    });
  });

  test("a marker-like line in the base file", async () => {
    const result = await reasonOf({
      "cat-file": (argv) =>
        argv.includes(BLOB_THEIRS) ? ok("a\n>>>>>>> topic\n") : ok("x\n"),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "marker_like_line",
    });
  });

  test("a separator-like line in a file", async () => {
    const result = await reasonOf({
      "cat-file": (argv) =>
        argv.includes(BLOB_OURS) ? ok("Title\n=======\n") : ok("x\n"),
    });
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "marker_like_line",
    });
  });

  test("aborts the merge so the worktree is left clean", async () => {
    const fake = scenario({ diff: () => ok("-\t-\tsrc/a.ts\0") });
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    const aborted = callsOf(fake.calls, "merge").some((call) =>
      call.argv.includes("--abort"),
    );
    expect(aborted).toBe(true);
  });

  test("does not create the baseline commit", async () => {
    const fake = scenario({ diff: () => ok("-\t-\tsrc/a.ts\0") });
    await mergeBaseIntoWorktree(mergeOptions(fake.run));
    expect(callsOf(fake.calls, "commit")).toEqual([]);
  });
});

describe("mergeBaseIntoWorktree guards", () => {
  test("stops before any git call when the .git pointer was replaced", async () => {
    const fake = scenario();
    await mergeBaseIntoWorktree(
      mergeOptions(fake.run, {
        pointerFs: {
          lstat: async () => ({
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
          readFile: async () => "gitdir: /elsewhere/.git/worktrees/x\n",
        },
      }),
    ).catch(() => undefined);
    expect(fake.calls).toEqual([]);
  });

  test("rejects with WorktreeGitPointerModifiedError when the .git pointer was replaced", async () => {
    const fake = scenario();
    const pending = mergeBaseIntoWorktree(
      mergeOptions(fake.run, {
        pointerFs: {
          lstat: async () => ({
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
          readFile: async () => "gitdir: /elsewhere/.git/worktrees/x\n",
        },
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(
      WorktreeGitPointerModifiedError,
    );
  });

  test("verifies the worktree before the pointer and any git call", async () => {
    const fake = scenario();
    let verifiedBeforeAnyGit = false;
    await mergeBaseIntoWorktree(
      mergeOptions(fake.run, {
        verifyWorktree: async () => {
          verifiedBeforeAnyGit = fake.calls.length === 0;
        },
      }),
    );
    expect(verifiedBeforeAnyGit).toBe(true);
  });

  test("rejects when HEAD is on another branch", async () => {
    const fake = scenario({
      "symbolic-ref": () => ok("refs/heads/other\n"),
    });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("rejects when HEAD is detached", async () => {
    const fake = scenario({ "symbolic-ref": () => fail("", 1) });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("rejects when the worktree has local changes before the merge", async () => {
    const fake = scenario({ status: () => ok("?? stray.txt\0") });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("does not run merge when the worktree has local changes", async () => {
    const fake = scenario({ status: () => ok("?? stray.txt\0") });
    await mergeBaseIntoWorktree(mergeOptions(fake.run)).catch(() => undefined);
    expect(callsOf(fake.calls, "merge")).toEqual([]);
  });

  test("rejects when the local HEAD is not the PR head", async () => {
    const fake = scenario({
      "rev-parse": (argv) =>
        argv.includes("HEAD") ? ok(`${"9".repeat(40)}\n`) : ok(`${BASE}\n`),
    });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("rejects when the baseline commit does not have the recorded parents", async () => {
    const fake = scenario({
      "rev-parse": (argv) => {
        if (argv.includes("--verify")) {
          return argv.includes("HEAD") ? ok(`${PR_HEAD}\n`) : ok(`${BASE}\n`);
        }
        return ok(`${AUTO}\n${BASE}\n${PR_HEAD}\n${TREE}\n`);
      },
    });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("rejects when an untracked file remains after the baseline commit", async () => {
    const fake = scenario({
      "ls-files": (argv) =>
        argv.includes("-u") ? ok(unmerged(["src/a.ts"])) : ok("stray.txt\0"),
    });
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run)),
    ).rejects.toBeInstanceOf(CommitBlockedError);
  });

  test("rejects an invalid PR head sha before running git", async () => {
    const fake = scenario();
    await expect(
      mergeBaseIntoWorktree(mergeOptions(fake.run, { prHeadSha: "-bad" })),
    ).rejects.toThrow(/invalid git SHA/);
  });

  test("throws when the merge fails for a reason other than conflicts", async () => {
    const fake = scenario({
      merge: () => fail("fatal: refusing to merge unrelated histories", 128),
    });
    await expect(mergeBaseIntoWorktree(mergeOptions(fake.run))).rejects.toThrow(
      /git merge failed/,
    );
  });

  test("throws when the merge reports a conflict but nothing is unmerged", async () => {
    const fake = scenario({ "ls-files": () => ok("") });
    await expect(mergeBaseIntoWorktree(mergeOptions(fake.run))).rejects.toThrow(
      /no unmerged/,
    );
  });
});

// ---------------------------------------------------------------------------
// 実際のgit
// ---------------------------------------------------------------------------

/** `null`はそのファイルを削除する。 */
type RepoFiles = Readonly<Record<string, string | null>>;

type Fixture = {
  readonly root: string;
  readonly repo: string;
  readonly worktree: string;
  readonly home: string;
  readonly prHead: string;
  readonly baseSha: string;
  readonly run: CommandRunner;
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
};

describe("mergeBaseIntoWorktree (real git)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function writeFiles(dir: string, files: RepoFiles): void {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      if (content === null) {
        rmSync(full);
        continue;
      }
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  /**
   * 初期のコミットから、PRのブランチとmainがそれぞれ別のファイルの変更を足した状態を作る。
   * originはローカルのbareリポジトリで、worktreeはPRのブランチの先頭にある。
   */
  async function setUp(files: {
    readonly initial: RepoFiles;
    readonly pr: RepoFiles;
    readonly main: RepoFiles;
    /** trueなら、mainの変更をPRのブランチを分ける前に入れる。baseがPRの履歴に含まれる。 */
    readonly mainBeforePr?: boolean;
  }): Promise<Fixture> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "merge-base-")));
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
    writeFiles(seed, files.initial);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "-q", "-m", "init"]);
    await git(seed, ["remote", "add", "origin", origin]);
    await git(seed, ["push", "-q", "origin", "main"]);
    const commitMain = async (): Promise<void> => {
      writeFiles(seed, files.main);
      await git(seed, ["add", "-A"]);
      await git(seed, ["commit", "-q", "-m", "main"]);
      await git(seed, ["push", "-q", "origin", "main"]);
    };
    if (files.mainBeforePr === true) await commitMain();
    await git(seed, ["checkout", "-q", "-b", "fix/branch"]);
    writeFiles(seed, files.pr);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "-q", "-m", "pr"]);
    await git(seed, ["push", "-q", "origin", "fix/branch"]);
    await git(seed, ["checkout", "-q", "main"]);
    if (files.mainBeforePr !== true) await commitMain();
    await git(root, ["clone", "-q", "--no-checkout", origin, repo]);
    await git(repo, [
      "branch",
      "--no-track",
      "fix/branch",
      "origin/fix/branch",
    ]);
    await git(repo, ["worktree", "add", "-q", worktree, "fix/branch"]);
    return {
      root,
      repo,
      worktree,
      home,
      prHead: await git(repo, ["rev-parse", "origin/fix/branch"]),
      baseSha: await git(repo, ["rev-parse", "origin/main"]),
      run,
      git,
    };
  }

  async function mergeOf(fixture: Fixture): Promise<MergeBaseResult> {
    const pointer = (await readWorktreeGitPointer(fixture.worktree)).content;
    return mergeBaseIntoWorktree({
      run: fixture.run,
      repoDir: fixture.repo,
      dir: fixture.worktree,
      branch: "fix/branch",
      worktreeGitPointer: pointer,
      prHeadSha: fixture.prHead,
      baseBranch: "main",
      author: AUTHOR,
      ghToken: "gh-token",
      home: fixture.home,
      lockFs: createInMemoryLockFs(),
    });
  }

  const CONFLICT = {
    initial: { "a.txt": "one\ntwo\nthree\n", "keep.txt": "keep\n" },
    pr: { "a.txt": "one\nPR\nthree\n" },
    main: { "a.txt": "one\nMAIN\nthree\n" },
  } as const;

  test("a real conflict yields a baseline commit that holds the conflicted path", async () => {
    const fixture = await setUp(CONFLICT);
    const result = await mergeOf(fixture);
    expect(result).toMatchObject({
      outcome: "merged",
      baseSha: fixture.baseSha,
      conflictedPaths: ["a.txt"],
    });
  });

  test("the baseline commit has the PR head and the base as parents, in that order", async () => {
    const fixture = await setUp(CONFLICT);
    const result = await mergeOf(fixture);
    const autoSha = result.outcome === "merged" ? result.autoSha : "";
    const parents = await fixture.git(fixture.worktree, [
      "log",
      "-1",
      "--format=%P",
      autoSha,
    ]);
    expect(parents).toBe(`${fixture.prHead} ${fixture.baseSha}`);
  });

  test("the baseline commit keeps the diff3 conflict markers in the file", async () => {
    const fixture = await setUp(CONFLICT);
    await mergeOf(fixture);
    const text = readFileSync(join(fixture.worktree, "a.txt"), "utf8");
    expect(text).toContain("||||||| ");
  });

  test("the recorded tree is the tree of the baseline commit", async () => {
    const fixture = await setUp(CONFLICT);
    const result = await mergeOf(fixture);
    const treeOfCommit = await fixture.git(fixture.worktree, [
      "rev-parse",
      "HEAD^{tree}",
    ]);
    expect(result).toMatchObject({ autoTreeSha: treeOfCommit });
  });

  test("the recorded blobs are the three stages of the conflicted path", async () => {
    const fixture = await setUp(CONFLICT);
    const result = await mergeOf(fixture);
    const blobs = result.outcome === "merged" ? result.conflictBlobs : [];
    const ours = await fixture.git(fixture.worktree, [
      "rev-parse",
      `${fixture.prHead}:a.txt`,
    ]);
    expect(blobs[0]?.oursBlob).toBe(ours);
  });

  test("the local branch points at the baseline commit and the worktree is clean", async () => {
    const fixture = await setUp(CONFLICT);
    await mergeOf(fixture);
    const status = await fixture.git(fixture.worktree, [
      "status",
      "--porcelain",
    ]);
    expect(status).toBe("");
  });

  test("changes on different files merge automatically with no conflicted path", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "a\n", "b.txt": "b\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b-main\n" },
    });
    const result = await mergeOf(fixture);
    expect(result).toMatchObject({ outcome: "merged", conflictedPaths: [] });
  });

  test("an automatic merge puts the changes of both sides in the baseline tree", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "a\n", "b.txt": "b\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b-main\n" },
    });
    await mergeOf(fixture);
    const merged = [
      readFileSync(join(fixture.worktree, "a.txt"), "utf8"),
      readFileSync(join(fixture.worktree, "b.txt"), "utf8"),
    ];
    expect(merged).toEqual(["a-pr\n", "b-main\n"]);
  });

  test("an automatic merge still records the two parents", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "a\n", "b.txt": "b\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b-main\n" },
    });
    const result = await mergeOf(fixture);
    const autoSha = result.outcome === "merged" ? result.autoSha : "";
    const parents = await fixture.git(fixture.worktree, [
      "log",
      "-1",
      "--format=%P",
      autoSha,
    ]);
    expect(parents).toBe(`${fixture.prHead} ${fixture.baseSha}`);
  });

  test("returns up_to_date when the base is already in the PR history", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "a\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b\n" },
      mainBeforePr: true,
    });
    const result = await mergeOf(fixture);
    expect(result).toEqual({ outcome: "up_to_date", baseSha: fixture.baseSha });
  });

  test("a binary conflict is unresolvable and leaves the worktree clean", async () => {
    const fixture = await setUp({
      initial: { "img.bin": "a\0b\n" },
      pr: { "img.bin": "a\0pr\n" },
      main: { "img.bin": "a\0main\n" },
    });
    const result = await mergeOf(fixture);
    expect(result).toEqual({ outcome: "unresolvable", reason: "binary" });
  });

  test("the worktree is clean after an unresolvable merge", async () => {
    const fixture = await setUp({
      initial: { "img.bin": "a\0b\n" },
      pr: { "img.bin": "a\0pr\n" },
      main: { "img.bin": "a\0main\n" },
    });
    await mergeOf(fixture);
    const status = await fixture.git(fixture.worktree, [
      "status",
      "--porcelain",
    ]);
    expect(status).toBe("");
  });

  test("a file with a merge attribute is unresolvable", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "one\ntwo\nthree\n" },
      pr: {
        "a.txt": "one\nPR\nthree\n",
        ".gitattributes": "a.txt merge=text\n",
      },
      main: { "a.txt": "one\nMAIN\nthree\n" },
    });
    const result = await mergeOf(fixture);
    expect(result).toEqual({ outcome: "unresolvable", reason: "attributes" });
  });

  test("a file that already contains conflict markers is unresolvable", async () => {
    const fixture = await setUp({
      initial: { "a.md": "one\ntwo\nthree\n" },
      pr: { "a.md": "one\n<<<<<<< sample\nPR\nthree\n" },
      main: { "a.md": "one\nMAIN\nthree\n" },
    });
    const result = await mergeOf(fixture);
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "marker_like_line",
    });
  });

  test("a delete/modify conflict is unresolvable", async () => {
    const fixture = await setUp({
      initial: { "a.txt": "one\ntwo\nthree\n" },
      pr: { "a.txt": "one\nPR\nthree\n" },
      main: { "a.txt": null },
    });
    const result = await mergeOf(fixture);
    expect(result).toEqual({
      outcome: "unresolvable",
      reason: "missing_stage",
    });
  });

  test("swapping the .git pointer stops the merge before anything is staged", async () => {
    const fixture = await setUp(CONFLICT);
    const pointer = (await readWorktreeGitPointer(fixture.worktree)).content;
    // 末尾をCRLFにしても、gitdirの検証は通る。記録との照合だけが止める。
    writeFileSync(join(fixture.worktree, ".git"), `${pointer.trim()}\r\n`);
    const pending = mergeBaseIntoWorktree({
      run: fixture.run,
      repoDir: fixture.repo,
      dir: fixture.worktree,
      branch: "fix/branch",
      worktreeGitPointer: pointer,
      prHeadSha: fixture.prHead,
      baseBranch: "main",
      author: AUTHOR,
      ghToken: "gh-token",
      home: fixture.home,
      lockFs: createInMemoryLockFs(),
    });
    await expect(pending).rejects.toBeInstanceOf(
      WorktreeGitPointerModifiedError,
    );
  });
});
