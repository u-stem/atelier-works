// CI回の変更の読み取り(PRが足した行の位置)を、実際のgitで確かめる。
// 複数のhunk、行数0のhunk、名前の変更、hunkをつなぐ設定、末尾改行の無い最終行を扱う。

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
import { collectCiFixChanges } from "../../f/factory/lib/ci_fix_round.ts";
import {
  type CommandRunner,
  runCommand,
} from "../../f/factory/lib/workspace.ts";

const TEST = "tests/a.test.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Repo = {
  readonly dir: string;
  readonly head: string;
  readonly base: { readonly mergeBase: string; readonly tip: string };
  readonly run: CommandRunner;
  readonly write: (path: string, content: string) => void;
};

/**
 * 基点のcommitを作り、`prSteps`でPRのcommitを作る。基点とbaseの先端は同じcommitである。
 * 戻ったときは、PRのheadをチェックアウトした状態で、作業ツリーに変更は無い。
 */
async function repoWithPr(input: {
  readonly base: Readonly<Record<string, string>>;
  readonly config?: readonly (readonly [string, string])[];
  /** PRを作った後にmainへ足すcommitの内容。baseの先端は、このcommitになる。 */
  readonly main?: Readonly<Record<string, string>>;
  readonly prSteps: (steps: {
    readonly write: (path: string, content: string) => void;
    readonly git: (args: readonly string[]) => Promise<string>;
  }) => Promise<void>;
}): Promise<Repo> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-fix-round-git-")));
  roots.push(root);
  const dir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(dir);
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
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await run(
      [
        "git",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  const write = (path: string, content: string): void => {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  await git(["init", "-q", "-b", "main"]);
  for (const [key, value] of input.config ?? []) {
    await git(["config", key, value]);
  }
  for (const [path, content] of Object.entries(input.base)) {
    write(path, content);
  }
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
  const mergeBase = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "-q", "-b", "pr"]);
  await input.prSteps({ write, git });
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "pr"]);
  const head = await git(["rev-parse", "HEAD"]);
  let tip = mergeBase;
  if (input.main !== undefined) {
    await git(["checkout", "-q", "main"]);
    for (const [path, content] of Object.entries(input.main)) {
      write(path, content);
    }
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "main"]);
    tip = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "-q", "pr"]);
  }
  return {
    dir,
    head,
    base: { mergeBase, tip },
    run,
    write,
  };
}

const lines = (...text: readonly string[]): string => `${text.join("\n")}\n`;

async function changeOf(repo: Repo, path: string) {
  const { changes } = await collectCiFixChanges(repo.run, repo.dir, repo.head, {
    source: "worktree",
    resolvePrBase: async () => repo.base,
  });
  return changes.find((change) => change.path === path);
}

describe("collectCiFixChanges with a real git", () => {
  const BASE = lines("b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9");
  const PR = lines(
    "b1",
    "b2",
    "p1",
    "b3",
    "b4",
    "b5",
    "b6",
    "p2",
    "b7",
    "b8",
    "p3",
  );

  async function severalHunks(): Promise<Repo> {
    return repoWithPr({
      base: { [TEST]: BASE },
      prSteps: async ({ write }) => write(TEST, PR),
    });
  }

  test("counts no line outside the pull request when the round rewrites lines of several hunks", async () => {
    const repo = await severalHunks();
    repo.write(
      TEST,
      lines("b1", "b2", "q1", "b3", "b4", "b5", "b6", "q2", "b7", "b8", "p3"),
    );
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(0);
  });

  test("counts a base line that the round rewrites between hunks of the pull request", async () => {
    const repo = await severalHunks();
    repo.write(
      TEST,
      lines("b1", "b2", "p1", "x3", "b4", "b5", "b6", "p2", "b7", "b8", "p3"),
    );
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("counts a base line that the round rewrites although the pull request added a line with the same text", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("});", "t1", "});") },
      prSteps: async ({ write }) =>
        write(TEST, lines("});", "t1", "});", "});", "n1")),
    });
    repo.write(TEST, lines("x", "t1", "});", "});", "n1"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("reads a hunk that only removes lines as removing lines the pull request added", async () => {
    const repo = await severalHunks();
    repo.write(
      TEST,
      lines("b1", "b2", "b3", "b4", "b5", "b6", "p2", "b7", "b8", "p3"),
    );
    const change = await changeOf(repo, TEST);
    expect([
      change?.removedOutsidePrLineCount,
      change?.shrinkingHunkCount,
    ]).toEqual([0, 1]);
  });

  test("does not join hunks of the pull request when diff.interHunkContext is set", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("b1", "b2", "b3", "b4", "b5") },
      config: [["diff.interHunkContext", "10"]],
      prSteps: async ({ write }) =>
        write(TEST, lines("b1", "b2", "p1", "b3", "b4", "p2", "b5")),
    });
    repo.write(TEST, lines("b1", "b2", "p1", "x3", "b4", "p2", "b5"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("reads the target of a rename as a file added as a whole, even when diff.renames is on", async () => {
    const repo = await repoWithPr({
      base: { "tests/old.test.ts": lines("b1", "b2", "b3") },
      config: [["diff.renames", "true"]],
      prSteps: async ({ write, git }) => {
        await git(["mv", "tests/old.test.ts", "tests/new.test.ts"]);
        write("tests/new.test.ts", lines("b1", "b2", "b3", "p1"));
      },
    });
    repo.write("tests/new.test.ts", lines("b1", "x2", "b3", "p1"));
    expect(
      (await changeOf(repo, "tests/new.test.ts"))?.removedOutsidePrLineCount,
    ).toBe(0);
  });

  test("does not take a base line that the pull request only re-indented for a line it added", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("  expect(a).toBe(1);", "  expect(b).toBe(2);") },
      prSteps: async ({ write }) =>
        write(
          TEST,
          lines("    expect(a).toBe(1);", "  expect(b).toBe(2);", "  run();"),
        ),
    });
    repo.write(
      TEST,
      lines("    expect(a).toBeDefined();", "  expect(b).toBe(2);", "  run();"),
    );
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("counts a line that the base branch already has after it moved on, as in a stacked pull request", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("b1", "b2", "b3") },
      main: { [TEST]: lines("b1", "b2", "p1", "b3") },
      prSteps: async ({ write }) =>
        write(TEST, lines("b1", "b2", "p1", "p2", "b3")),
    });
    repo.write(TEST, lines("b1", "b2", "q1", "p2", "b3"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("counts no line outside the pull request for a line only the pull request has after the base branch moved on", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("b1", "b2", "b3") },
      main: { [TEST]: lines("b1", "b2", "p1", "b3") },
      prSteps: async ({ write }) =>
        write(TEST, lines("b1", "b2", "p1", "p2", "b3")),
    });
    repo.write(TEST, lines("b1", "b2", "p1", "q2", "b3"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(0);
  });

  test("counts no line outside the pull request when the base branch changed elsewhere after the pull request branched", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("b1", "b2", "b3") },
      main: { [TEST]: lines("b1", "b2", "b3", "m1") },
      prSteps: async ({ write }) => write(TEST, lines("b1", "b2", "p1", "b3")),
    });
    repo.write(TEST, lines("b1", "b2", "q1", "b3"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(0);
  });

  test("does not take the last base line without a newline for a line the pull request added", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: "b1\nb2" },
      prSteps: async ({ write }) => write(TEST, lines("b1", "b2", "p1")),
    });
    repo.write(TEST, lines("b1", "x2", "p1"));
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(1);
  });

  test("keeps a last line without a newline as added when the pull request wrote it", async () => {
    const repo = await repoWithPr({
      base: { [TEST]: lines("b1", "b2") },
      prSteps: async ({ write }) => write(TEST, "b1\nb2\np1"),
    });
    repo.write(TEST, "b1\nb2\nq1");
    expect((await changeOf(repo, TEST))?.removedOutsidePrLineCount).toBe(0);
  });
});
