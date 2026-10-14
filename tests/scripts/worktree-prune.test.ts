import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/worktree-prune.sh");
const BASH = Bun.which("bash") ?? "bash";

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

function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("worktree-prune.sh", () => {
  let root: string;
  let originDir: string;
  let mainDir: string;
  let fakeBin: string;

  // 偽のghの本体を差し替える。引数は無視する。
  function writeGh(body: string): void {
    writeFileSync(join(fakeBin, "gh"), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fakeBin, "gh"), 0o755);
  }

  function run(args: string[] = [], cwd: string = mainDir): Run {
    const result = Bun.spawnSync([BASH, SCRIPT, ...args], {
      cwd,
      env: { ...cleanEnv(), PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  const worktreePath = (name: string) =>
    join(mainDir, ".claude", "worktrees", name);

  function branchExists(branch: string): boolean {
    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: mainDir, env: cleanEnv() },
    );
    return result.exitCode === 0;
  }

  // origin/mainから、`.claude/worktrees/<name>`にブランチ`<branch>`のworktreeを作る。
  function addWorktree(name: string, branch: string): string {
    const path = worktreePath(name);
    git(mainDir, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      path,
      "origin/main",
    ]);
    return path;
  }

  // worktreeのブランチに、origin/mainに無いcommitを足してshaを返す。
  function commitIn(path: string): string {
    git(path, [
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "work",
    ]);
    return git(path, ["rev-parse", "HEAD"]);
  }

  // originのmainを1コミット進めて、メインのcheckoutに取り込む。
  function advanceOrigin(): void {
    const other = join(root, "other");
    git(root, ["clone", "--quiet", originDir, other]);
    writeFileSync(join(other, "new.txt"), "y\n");
    git(other, ["add", "new.txt"]);
    git(other, ["commit", "--quiet", "--no-gpg-sign", "-m", "advance"]);
    git(other, ["push", "--quiet", "origin", "main"]);
    git(mainDir, ["fetch", "--quiet", "origin"]);
  }

  // worktreeを作って1コミットし、そのcommitをfast-forwardでorigin/mainに入れる。
  function addMergedWorktree(name: string, branch: string): string {
    const path = addWorktree(name, branch);
    const sha = commitIn(path);
    git(path, ["push", "--quiet", "origin", `${sha}:refs/heads/main`]);
    git(mainDir, ["fetch", "--quiet", "origin"]);
    return path;
  }

  beforeEach(() => {
    root = makeTempRoot("worktree-prune-");
    originDir = join(root, "origin.git");
    mainDir = join(root, "main");
    fakeBin = join(root, "fakebin");
    mkdirSync(fakeBin);
    writeGh("exit 0");

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
    writeFileSync(join(mainDir, ".gitignore"), "node_modules/\n.claude/\n");
    git(mainDir, ["add", "README.md", ".gitignore"]);
    git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
    git(mainDir, ["push", "--quiet", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("usage", () => {
    test("rejects an unknown option with 2", () => {
      const result = run(["--bogus"]);

      expect(result.exitCode).toBe(2);
    });

    test("rejects two arguments with 2", () => {
      const result = run(["--apply", "--apply"]);

      expect(result.exitCode).toBe(2);
    });

    test("prints the usage to stderr", () => {
      const result = run(["--bogus"]);

      expect(result.stderr).toContain("usage:");
    });
  });

  describe("a branch that is an ancestor of origin/main", () => {
    let path: string;

    beforeEach(() => {
      path = addMergedWorktree("docs-old", "docs/old");
    });

    test("is listed as would remove in the dry run", () => {
      const result = run();

      expect(result.stdout).toContain(
        `would remove: ${path} (docs/old): ancestor of origin/main`,
      );
    });

    test("is not removed in the dry run", () => {
      run();

      expect(existsSync(path)).toBe(true);
    });

    test("keeps its branch in the dry run", () => {
      run();

      expect(branchExists("docs/old")).toBe(true);
    });

    test("exits with 0 in the dry run", () => {
      const result = run();

      expect(result.exitCode).toBe(0);
    });

    test("removes the worktree with --apply", () => {
      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    test("removes the branch with --apply", () => {
      run(["--apply"]);

      expect(branchExists("docs/old")).toBe(false);
    });

    test("reports the removal with --apply", () => {
      const result = run(["--apply"]);

      expect(result.stdout).toContain(`removed: ${path} (docs/old)`);
    });

    test("does not ask gh", () => {
      writeGh("exit 1");

      const result = run();

      expect(result.stdout).not.toContain("gh unavailable");
    });
  });

  describe("a branch that was created and never used", () => {
    let path: string;

    beforeEach(() => {
      path = addWorktree("docs-fresh", "docs/fresh");
      advanceOrigin();
    });

    test("is kept as unused even though origin/main moved on", () => {
      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/fresh): unused`);
    });

    test("is not removed with --apply", () => {
      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps its branch with --apply", () => {
      run(["--apply"]);

      expect(branchExists("docs/fresh")).toBe(true);
    });
  });

  describe("a branch whose reflog is gone", () => {
    let path: string;

    beforeEach(() => {
      path = addMergedWorktree("docs-nolog", "docs/nolog");
      rmSync(join(mainDir, ".git", "logs", "refs", "heads", "docs", "nolog"));
    });

    test("is kept as unused", () => {
      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/nolog): unused`);
    });

    test("is not removed with --apply", () => {
      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });
  });

  describe("a squash-merged branch", () => {
    let path: string;
    let tip: string;

    beforeEach(() => {
      path = addWorktree("feat-squash", "feat/squash");
      tip = commitIn(path);
    });

    test("is removed when gh reports a merged pull request with the same head", () => {
      writeGh(`echo ${tip}`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    test("loses its branch when gh reports the same head", () => {
      writeGh(`echo ${tip}`);

      run(["--apply"]);

      expect(branchExists("feat/squash")).toBe(false);
    });

    test("is kept as unmerged when gh reports another head", () => {
      writeGh("echo 0000000000000000000000000000000000000000");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (feat/squash): unmerged`);
    });

    test("is kept as unmerged when gh reports no merged pull request", () => {
      writeGh("exit 0");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (feat/squash): unmerged`);
    });

    test("is kept as gh unavailable when gh fails", () => {
      writeGh("exit 1");

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (feat/squash): gh unavailable`,
      );
    });

    test("is kept as gh unavailable when gh is not installed", () => {
      // ghだけを含まないPATHを作る。
      rmSync(join(fakeBin, "gh"));
      for (const tool of ["git", "basename", "dirname"]) {
        symlinkSync(requireBin(tool), join(fakeBin, tool));
      }
      const result = Bun.spawnSync([BASH, SCRIPT], {
        cwd: mainDir,
        env: { ...cleanEnv(), PATH: fakeBin },
      });

      expect(result.stdout.toString()).toContain("gh unavailable");
    });

    test("is not removed when gh fails, even with --apply", () => {
      writeGh("exit 1");

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps its branch when it moves on between the check and the removal", () => {
      // ghの応答の後、worktreeの掃除の前にブランチが進む。
      writeGh(
        `echo ${tip}\ngit -C "${path}" commit --quiet --allow-empty --no-gpg-sign -m race`,
      );

      run(["--apply"]);

      expect(branchExists("feat/squash")).toBe(true);
    });

    test("tells that the branch remains when it moves on", () => {
      writeGh(
        `echo ${tip}\ngit -C "${path}" commit --quiet --allow-empty --no-gpg-sign -m race`,
      );

      const result = run(["--apply"]);

      expect(result.stdout).toContain("but branch feat/squash remains");
    });
  });

  describe("a worktree that must be kept", () => {
    test("is kept as dirty when it has an untracked file", () => {
      const path = addWorktree("fix-dirty", "fix/dirty");
      advanceOrigin();
      writeFileSync(join(path, "untracked.txt"), "u\n");

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (fix/dirty): dirty`);
    });

    test("is not removed when it is dirty", () => {
      const path = addWorktree("fix-dirty", "fix/dirty");
      advanceOrigin();
      writeFileSync(join(path, "untracked.txt"), "u\n");

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("is kept as locked when it is locked", () => {
      const path = addWorktree("fix-locked", "fix/locked");
      advanceOrigin();
      git(mainDir, ["worktree", "lock", path]);

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (fix/locked): locked`);
    });

    test("is not removed when it is locked", () => {
      const path = addWorktree("fix-locked", "fix/locked");
      advanceOrigin();
      git(mainDir, ["worktree", "lock", path]);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("is kept as detached when HEAD points at no branch", () => {
      const path = worktreePath("fix-detached");
      git(mainDir, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        path,
        "origin/main",
      ]);
      advanceOrigin();

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path}: detached`);
    });

    test("is kept as current directory when the script runs inside it", () => {
      const path = addWorktree("fix-current", "fix/current");
      advanceOrigin();

      const result = run(["--apply"], path);

      expect(result.stdout).toContain(
        `kept: ${path} (fix/current): current directory`,
      );
    });
  });

  describe("a worktree outside .claude/worktrees", () => {
    let outside: string;

    beforeEach(() => {
      outside = join(root, "elsewhere");
      git(mainDir, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "fix/out",
        outside,
        "origin/main",
      ]);
      advanceOrigin();
    });

    test("is kept as outside", () => {
      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${outside} (fix/out): outside`);
    });

    test("is not removed", () => {
      run(["--apply"]);

      expect(existsSync(outside)).toBe(true);
    });

    test("keeps its branch", () => {
      run(["--apply"]);

      expect(branchExists("fix/out")).toBe(true);
    });

    test("keeps the main checkout", () => {
      run(["--apply"]);

      expect(existsSync(join(mainDir, "README.md"))).toBe(true);
    });

    test("lists the main checkout as outside", () => {
      const result = run();

      expect(result.stdout).toContain(`kept: ${mainDir} (main): outside`);
    });
  });

  test("works when run from another worktree", () => {
    const old = addMergedWorktree("docs-old", "docs/old");
    const other = addWorktree("fix-other", "fix/other");
    commitIn(other);

    run(["--apply"], other);

    expect(existsSync(old)).toBe(false);
  });

  test("summarizes the counts at the end of the dry run", () => {
    addMergedWorktree("docs-old", "docs/old");

    const result = run();

    expect(result.stdout.trim().split("\n").pop()).toBe(
      "dry run: would remove 1, keep 1. Pass --apply to remove.",
    );
  });

  test("summarizes the counts at the end of --apply", () => {
    addMergedWorktree("docs-old", "docs/old");

    const result = run(["--apply"]);

    expect(result.stdout.trim().split("\n").pop()).toBe("removed 1, kept 1");
  });
});

// PATHにあるコマンドの絶対パスを返す。
function requireBin(name: string): string {
  const found = Bun.which(name);
  if (found === null) {
    throw new Error(`${name} not found`);
  }
  return found;
}
