// 競合回の検証と完了の流れを、実際のgitで確かめる。
// mergeして基準コミットを作り、ファイルを編集し、解消を検査し、検査したツリーをpushする。
// gitleaksだけは偽物にする。

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflictPrepare } from "../../f/factory/lib/conflict_fix_round.ts";
import {
  gitConflictInspectDeps,
  inspectConflictResolution,
} from "../../f/factory/lib/conflict_fix_verify.ts";
import {
  type CommandRunner,
  type LockFs,
  listBothSidesChangedPaths,
  mergeBaseIntoWorktree,
  pushMergeCommit,
  readWorktreeGitPointer,
  runCommand,
} from "../../f/factory/lib/workspace.ts";
import { ok } from "./testSupport.ts";

const AUTHOR = { name: "factory-bot", email: "bot@example.invalid" };

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

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Files = Readonly<Record<string, string>>;

type Fixture = {
  readonly repo: string;
  readonly worktree: string;
  readonly home: string;
  readonly prHead: string;
  readonly run: CommandRunner;
  /** gitleaksに渡された標準入力。 */
  readonly scanned: string[];
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
};

function writeFiles(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

/** PRのブランチとmainが別の変更を足した状態を、ローカルのbareリポジトリを持つ形で作る。 */
async function fixture(files: {
  readonly initial: Files;
  readonly pr: Files;
  readonly main: Files;
}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conflict-verify-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const repo = join(root, "repo");
  const worktree = join(root, "wt");
  const home = join(root, "home");
  mkdirSync(seed);
  mkdirSync(home);
  const scanned: string[] = [];
  const run: CommandRunner = async (argv, options) => {
    if (argv[0] === "gitleaks") {
      scanned.push(options?.stdin ?? "");
      return ok("[]");
    }
    return runCommand(argv, {
      ...options,
      env: {
        ...options?.env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "https:file",
      },
    });
  };
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
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
  await git(seed, ["checkout", "-q", "-b", "fix/branch"]);
  writeFiles(seed, files.pr);
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-q", "-m", "pr"]);
  await git(seed, ["push", "-q", "origin", "fix/branch"]);
  await git(seed, ["checkout", "-q", "main"]);
  writeFiles(seed, files.main);
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-q", "-m", "main"]);
  await git(seed, ["push", "-q", "origin", "main"]);
  await git(root, ["clone", "-q", "--no-checkout", origin, repo]);
  await git(repo, ["branch", "--no-track", "fix/branch", "origin/fix/branch"]);
  await git(repo, ["worktree", "add", "-q", worktree, "fix/branch"]);
  return {
    repo,
    worktree,
    home,
    prHead: await git(repo, ["rev-parse", "origin/fix/branch"]),
    run,
    scanned,
    git,
  };
}

const FILES = {
  initial: {
    "a.txt": "one\ntwo\nthree\n",
    "b.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n",
  },
  pr: { "a.txt": "one\nPR\nthree\n", "b.txt": "PR1\n2\n3\n4\n5\n6\n7\n8\n9\n" },
  main: {
    "a.txt": "one\nMAIN\nthree\n",
    "b.txt": "1\n2\n3\n4\n5\n6\n7\n8\nMAIN9\n",
  },
} as const;

/** mergeして基準コミットを作り、その結果と、検査の入力を返す。 */
async function mergedFixture(
  files: { initial: Files; pr: Files; main: Files } = FILES,
) {
  const f = await fixture(files);
  const pointer = (await readWorktreeGitPointer(f.worktree)).content;
  const merge = await mergeBaseIntoWorktree({
    run: f.run,
    repoDir: f.repo,
    dir: f.worktree,
    branch: "fix/branch",
    worktreeGitPointer: pointer,
    prHeadSha: f.prHead,
    baseBranch: "main",
    author: AUTHOR,
    ghToken: "gh-token",
    home: f.home,
    lockFs: createInMemoryLockFs(),
  });
  if (merge.outcome !== "merged") {
    throw new Error(`expected a merged result: ${merge.outcome}`);
  }
  const plan = await planConflictPrepare(merge, (tree, baseSha) =>
    listBothSidesChangedPaths({
      run: f.run,
      worktreeDir: f.worktree,
      prHeadSha: f.prHead,
      baseSha,
      treeSha: tree,
      home: f.home,
    }),
  );
  if (plan.kind !== "proceed")
    throw new Error(`expected proceed: ${plan.kind}`);
  const inspect = () =>
    inspectConflictResolution(
      gitConflictInspectDeps({
        run: f.run,
        worktreeDir: f.worktree,
        conflictedPaths: plan.conflictedPaths,
        baselineSha: plan.autoSha,
        prHeadSha: f.prHead,
        baseSha: plan.baseSha,
        scanText: async () => ({ ok: true, output: "" }),
        gitleaksTimeoutMs: 10_000,
        home: f.home,
      }),
      {
        conflictedPaths: plan.conflictedPaths,
        conflictBlobs: plan.conflictBlobs,
        autoTreeSha: plan.autoTreeSha,
      },
    );
  return { f, plan, inspect, pointer };
}

describe("a resolution inspected with real git", () => {
  test("accepts a resolution that keeps both sides", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, { "a.txt": "one\nPR\nMAIN\nthree\n" });
    expect((await inspect()).reasons).toEqual([]);
  });

  test("accepts a resolution that takes the PR side", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, { "a.txt": "one\nPR\nthree\n" });
    expect((await inspect()).reasons).toEqual([]);
  });

  test("stops at a conflict marker that is left in the file", async () => {
    const { inspect } = await mergedFixture();
    expect((await inspect()).reasons).toEqual([
      "conflict round: change not allowed (marker_left): a.txt",
    ]);
  });

  test("stops at a line that is outside the conflict block", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, { "a.txt": "ONE\nPR\nthree\n" });
    expect((await inspect()).reasons).toEqual([
      "conflict round: change not allowed (not_in_conflict_block): a.txt",
    ]);
  });

  test("stops at an edit of a file that is not conflicted", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, {
      "a.txt": "one\nPR\nthree\n",
      "b.txt": "PR1\n2\n3\n4\n5\n6\n7\n8\nEDITED\n",
    });
    expect((await inspect()).reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): b.txt",
    ]);
  });

  test("stops at a new file", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, {
      "a.txt": "one\nPR\nthree\n",
      "added.txt": "new\n",
    });
    expect((await inspect()).reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): added.txt",
    ]);
  });

  test("scans the difference from the PR head of the file that both sides changed", async () => {
    const { f, inspect } = await mergedFixture();
    writeFiles(f.worktree, { "a.txt": "one\nPR\nMAIN\nthree\n" });
    await inspect();
    expect(f.scanned.join("\n")).toContain("+MAIN9");
  });

  test("accepts a merge without conflicts and returns the tree of the baseline commit", async () => {
    const { plan, inspect } = await mergedFixture({
      initial: { "a.txt": "a\n", "b.txt": "b\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b-main\n" },
    });
    const inspection = await inspect();
    expect([plan.conflictedPaths, inspection]).toEqual([
      [],
      { treeSha: plan.autoTreeSha, reasons: [] },
    ]);
  });

  test("stops a merge without conflicts when a file is edited", async () => {
    const { f, inspect } = await mergedFixture({
      initial: { "a.txt": "a\n", "b.txt": "b\n" },
      pr: { "a.txt": "a-pr\n" },
      main: { "b.txt": "b-main\n" },
    });
    writeFiles(f.worktree, { "a.txt": "edited\n" });
    expect((await inspect()).reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): a.txt",
    ]);
  });

  test("returns a tree that pushMergeCommit pushes as a merge commit of the PR head and the base", async () => {
    const { f, plan, inspect, pointer } = await mergedFixture();
    writeFiles(f.worktree, { "a.txt": "one\nPR\nMAIN\nthree\n" });
    const inspection = await inspect();
    const pushed = await pushMergeCommit({
      run: f.run,
      repoDir: f.repo,
      dir: f.worktree,
      branch: "fix/branch",
      worktreeGitPointer: pointer,
      prHeadSha: f.prHead,
      baseSha: plan.baseSha,
      baseBranch: "main",
      autoSha: plan.autoSha,
      expectedTreeSha: inspection.treeSha,
      conflictedPaths: plan.conflictedPaths,
      instanceName: "acme-factory",
      author: AUTHOR,
      ghToken: "gh-token",
      home: f.home,
      lockFs: createInMemoryLockFs(),
    });
    expect(pushed.outcome).toBe("pushed");
  });
});
