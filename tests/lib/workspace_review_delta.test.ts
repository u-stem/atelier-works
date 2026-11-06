// `readReviewDelta`を、本物のリポジトリで確かめる。
// 前回のcommitが読めるか、merge commitがあるか、変更ファイルに絞れるかはgitの挙動なので、偽物では確かめられない。

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  readReviewDelta,
  runCommand,
} from "../../f/factory/lib/workspace.ts";
import { reviewDeltaPaths } from "../../f/factory/steps/pr_workflow_support.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-delta-")));
  roots.push(dir);
  const run: CommandRunner = (argv, options) =>
    runCommand(argv, {
      ...options,
      env: { ...options?.env, PATH: process.env.PATH ?? "", HOME: dir },
    });
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
  const commit = async (files: Record<string, string>): Promise<string> => {
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(dir, path), content);
    }
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "change"]);
    return git(["rev-parse", "HEAD"]);
  };
  return { dir, run, git, commit };
}

// 移動先のパスだけを渡すと、gitは新しいファイルとして出すので、移動元で消した行が差分から消える。
describe("readReviewDelta with a renamed file", () => {
  async function renamedDelta(): Promise<string> {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const lines = Array.from({ length: 20 }, (_, i) => `line-${String(i)}`);
    const from = await commit({ "old.ts": `${lines.join("\n")}\n` });
    rmSync(join(dir, "old.ts"));
    const head = await commit({
      "new.ts": `${lines.filter((line) => line !== "line-5").join("\n")}\n`,
    });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: reviewDeltaPaths([
        { filename: "new.ts", previous_filename: "old.ts" },
      ]),
    });
    return delta?.diff ?? "";
  }

  test("shows the old path", async () => {
    expect(await renamedDelta()).toContain("rename from old.ts");
  });

  test("shows the new path", async () => {
    expect(await renamedDelta()).toContain("rename to new.ts");
  });

  test("shows the line removed by the rename", async () => {
    expect(await renamedDelta()).toContain("-line-5");
  });
});

describe("readReviewDelta", () => {
  test("returns the changes since the prior commit", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const from = await commit({ "a.ts": "one\n" });
    const head = await commit({ "a.ts": "two\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta?.diff).toContain("+two");
  });

  test("leaves out a file the PR does not change", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const from = await commit({ "a.ts": "one\n", "b.ts": "one\n" });
    const head = await commit({ "a.ts": "two\n", "b.ts": "two\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta?.diff).not.toContain("b.ts");
  });

  test("reads a path with a glob character literally", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const from = await commit({ "a.ts": "one\n" });
    const head = await commit({ "a.ts": "two\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["*.ts"],
    });
    expect(delta?.diff).toBe("");
  });

  test("returns an empty diff when the PR changes no file", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const from = await commit({ "a.ts": "one\n" });
    const head = await commit({ "a.ts": "two\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: [],
    });
    expect(delta?.diff).toBe("");
  });

  test("reports no merge for a straight range", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const from = await commit({ "a.ts": "one\n" });
    const head = await commit({ "a.ts": "two\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta?.hasMerge).toBe(false);
  });

  test("reports a merge commit in the range", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    await commit({ "base.ts": "one\n" });
    await git(["checkout", "-q", "-b", "feature"]);
    const from = await commit({ "a.ts": "one\n" });
    await git(["checkout", "-q", "main"]);
    await commit({ "base.ts": "two\n" });
    await git(["checkout", "-q", "feature"]);
    await git(["merge", "-q", "--no-edit", "main"]);
    const head = await git(["rev-parse", "HEAD"]);
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta?.hasMerge).toBe(true);
  });

  test("returns null when the prior commit is not an ancestor", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const base = await commit({ "a.ts": "one\n" });
    const from = await commit({ "a.ts": "two\n" });
    await git(["reset", "-q", "--hard", base]);
    const head = await commit({ "a.ts": "three\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: from,
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta).toBeNull();
  });

  test("returns null when the prior commit does not exist", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const head = await commit({ "a.ts": "one\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: "f".repeat(40),
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta).toBeNull();
  });

  test("returns null for a value that is not a commit sha", async () => {
    const { dir, run, git, commit } = repo();
    await git(["init", "-q", "-b", "main"]);
    const head = await commit({ "a.ts": "one\n" });
    const delta = await readReviewDelta({
      run,
      dir,
      fromSha: "--help",
      headSha: head,
      paths: ["a.ts"],
    });
    expect(delta).toBeNull();
  });
});
