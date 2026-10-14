import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/worktree-new.sh");

// フックの中で動くとGIT_DIRなどが入るので、テスト用のリポジトリに漏らさない。
// グローバルとシステムのgit設定も読ませない。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "test";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "test";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  return env;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: cleanEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

type Run = { exitCode: number; stdout: string; stderr: string };

function runScript(cwd: string, args: string[], bun: string): Run {
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd,
    env: { ...cleanEnv(), WORKTREE_NEW_BUN: bun },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// macOSの/var/foldersは/private/varへのリンクなので、実パスにそろえる。
function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// 呼ばれた作業ディレクトリと引数を1行ずつ記録し、本物と同じく`node_modules`を作るだけのbun。
function writeFakeBun(path: string, log: string, exitCode: number): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$PWD $*" >> "${log}"\nmkdir -p node_modules\ntouch node_modules/marker\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
}

describe("worktree-new.sh", () => {
  let root: string;
  let originDir: string;
  let mainDir: string;
  let fakeBun: string;
  let bunLog: string;

  beforeEach(() => {
    root = makeTempRoot("worktree-new-");
    originDir = join(root, "origin.git");
    mainDir = join(root, "main");
    fakeBun = join(root, "fake-bun");
    bunLog = join(root, "bun.log");
    writeFakeBun(fakeBun, bunLog, 0);

    git(root, [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      originDir,
    ]);
    git(root, ["clone", "--quiet", originDir, mainDir]);
    git(mainDir, ["checkout", "--quiet", "-b", "main"]);
    writeFileSync(join(mainDir, "README.md"), "x\n");
    writeFileSync(join(mainDir, ".gitignore"), "node_modules/\n");
    git(mainDir, ["add", "README.md", ".gitignore"]);
    git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
    git(mainDir, ["push", "--quiet", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // originのmainだけを1コミット進める。メインのcheckoutのmainは古いままになる。
  function advanceOrigin(): string {
    const other = join(root, "other");
    git(root, ["clone", "--quiet", originDir, other]);
    writeFileSync(join(other, "new.txt"), "y\n");
    git(other, ["add", "new.txt"]);
    git(other, ["commit", "--quiet", "--no-gpg-sign", "-m", "advance"]);
    git(other, ["push", "--quiet", "origin", "main"]);
    return git(other, ["rev-parse", "HEAD"]);
  }

  const target = () => join(mainDir, ".claude", "worktrees", "feat-foo");

  function branchExists(branch: string): boolean {
    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: mainDir, env: cleanEnv() },
    );
    return result.exitCode === 0;
  }

  test("creates nothing under .claude on a bad argument", () => {
    runScript(mainDir, ["wip/foo"], fakeBun);

    expect(existsSync(join(mainDir, ".claude"))).toBe(false);
  });

  test("rejects a type outside the allowed list", () => {
    const result = runScript(mainDir, ["wip/foo"], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name with an uppercase letter", () => {
    const result = runScript(mainDir, ["feat/Foo"], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name with an underscore", () => {
    const result = runScript(mainDir, ["feat/foo_bar"], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name that contains a slash", () => {
    const result = runScript(mainDir, ["feat/foo/bar"], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects an argument without a slash", () => {
    const result = runScript(mainDir, ["feat"], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a missing argument", () => {
    const result = runScript(mainDir, [], fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("prints the usage to stderr on a bad argument", () => {
    const result = runScript(mainDir, ["wip/foo"], fakeBun);

    expect(result.stderr).toContain("usage:");
  });

  test("prints nothing to stdout on a bad argument", () => {
    const result = runScript(mainDir, ["wip/foo"], fakeBun);

    expect(result.stdout).toBe("");
  });

  test("creates the branch named type/name", () => {
    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(git(target(), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "feat/foo",
    );
  });

  test("names the directory type-name under .claude/worktrees", () => {
    runScript(mainDir, ["docs/bar-baz"], fakeBun);

    expect(
      existsSync(join(mainDir, ".claude", "worktrees", "docs-bar-baz", ".git")),
    ).toBe(true);
  });

  test("accepts every allowed type", () => {
    const types = ["feat", "fix", "docs", "refactor", "test", "chore"];

    const exitCodes = types.map(
      (type) => runScript(mainDir, [`${type}/x1`], fakeBun).exitCode,
    );

    expect(exitCodes).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("branches from the fetched origin/main, not the local main", () => {
    const originHead = advanceOrigin();

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(git(target(), ["rev-parse", "HEAD"])).toBe(originHead);
  });

  test("does not track origin/main", () => {
    runScript(mainDir, ["feat/foo"], fakeBun);

    const result = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "feat/foo@{upstream}"],
      { cwd: mainDir, env: cleanEnv() },
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("creates the worktree under the main checkout when run from the main checkout", () => {
    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("creates the worktree under the main checkout when run from another worktree", () => {
    runScript(mainDir, ["fix/first"], fakeBun);
    const first = join(mainDir, ".claude", "worktrees", "fix-first");

    const result = runScript(first, ["feat/foo"], fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("does not nest a worktree inside the worktree it runs from", () => {
    runScript(mainDir, ["fix/first"], fakeBun);
    const first = join(mainDir, ".claude", "worktrees", "fix-first");

    runScript(first, ["feat/foo"], fakeBun);

    expect(existsSync(join(first, ".claude"))).toBe(false);
  });

  test("creates the worktree when run from a subdirectory of the main checkout", () => {
    const sub = join(mainDir, "sub");
    mkdirSync(sub);

    const result = runScript(sub, ["feat/foo"], fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("prints only the absolute path to stdout", () => {
    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.stdout).toBe(`${target()}\n`);
  });

  test("exits with zero on success", () => {
    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).toBe(0);
  });

  test("installs root and console dependencies inside the new worktree", () => {
    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(readFileSync(bunLog, "utf8").trim().split("\n")).toEqual([
      `${target()} install --frozen-lockfile --ignore-scripts`,
      `${target()} install --cwd console --frozen-lockfile --ignore-scripts`,
    ]);
  });

  test("fails when the install fails", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("runs the install before the install failure", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(bunLog)).toBe(true);
  });

  test("removes the worktree directory when the install fails", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("removes the branch when the install fails", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("unregisters the worktree when the install fails", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(git(mainDir, ["worktree", "list", "--porcelain"])).not.toContain(
      "feat-foo",
    );
  });

  test("tells how to rerun when the install fails", () => {
    writeFakeBun(fakeBun, bunLog, 1);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.stderr).toContain("rerun: scripts/worktree-new.sh feat/foo");
  });

  test("succeeds when rerun with the same argument after an install failure", () => {
    writeFakeBun(fakeBun, bunLog, 1);
    runScript(mainDir, ["feat/foo"], fakeBun);
    writeFakeBun(fakeBun, bunLog, 0);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).toBe(0);
  });

  test("keeps a pre-existing worktree of another name when the install fails", () => {
    runScript(mainDir, ["fix/first"], fakeBun);
    writeFakeBun(fakeBun, bunLog, 1);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(
      existsSync(join(mainDir, ".claude", "worktrees", "fix-first", ".git")),
    ).toBe(true);
  });

  test("prints the first push command to stderr on success", () => {
    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.stderr).toContain("git push -u origin HEAD");
  });

  test("fails when the branch already exists on origin", () => {
    git(mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("does not create the directory when the branch exists on origin", () => {
    git(mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("does not create the local branch when the branch exists on origin", () => {
    git(mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("fails when the fetch fails", () => {
    git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("does not create the directory when the fetch fails", () => {
    git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("does not create the branch when the fetch fails", () => {
    git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("fails when run from a bare repository", () => {
    const result = runScript(originDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("creates nothing next to a bare repository", () => {
    runScript(originDir, ["feat/foo"], fakeBun);

    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("fails when the branch already exists", () => {
    git(mainDir, ["branch", "feat/foo"]);

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("leaves the existing branch untouched", () => {
    git(mainDir, ["branch", "feat/foo"]);
    const before = git(mainDir, ["rev-parse", "feat/foo"]);
    advanceOrigin();

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(git(mainDir, ["rev-parse", "feat/foo"])).toBe(before);
  });

  test("does not create the directory when the branch already exists", () => {
    git(mainDir, ["branch", "feat/foo"]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("fails when the directory already exists", () => {
    mkdirSync(target(), { recursive: true });

    const result = runScript(mainDir, ["feat/foo"], fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("leaves the existing directory contents untouched", () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "keep.txt"), "keep\n");

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(readFileSync(join(target(), "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("does not create the branch when the directory already exists", () => {
    mkdirSync(target(), { recursive: true });

    runScript(mainDir, ["feat/foo"], fakeBun);

    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", "refs/heads/feat/foo"],
      { cwd: mainDir, env: cleanEnv() },
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("does not run the install when it refuses to create the worktree", () => {
    git(mainDir, ["branch", "feat/foo"]);

    runScript(mainDir, ["feat/foo"], fakeBun);

    expect(existsSync(bunLog)).toBe(false);
  });
});
