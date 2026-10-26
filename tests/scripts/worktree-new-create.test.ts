import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanEnv,
  git,
  runScript,
  setupNewHarness,
  writeFakeBun,
} from "./worktree-new-support";

describe("worktree-new.sh", () => {
  const h = setupNewHarness();
  const { target, advanceOrigin, branchExists } = h;

  test("creates nothing under .claude on a bad argument", () => {
    runScript(h.mainDir, ["wip/foo"], h.fakeBun);

    expect(existsSync(join(h.mainDir, ".claude"))).toBe(false);
  });

  test("rejects a type outside the allowed list", () => {
    const result = runScript(h.mainDir, ["wip/foo"], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name with an uppercase letter", () => {
    const result = runScript(h.mainDir, ["feat/Foo"], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name with an underscore", () => {
    const result = runScript(h.mainDir, ["feat/foo_bar"], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a name that contains a slash", () => {
    const result = runScript(h.mainDir, ["feat/foo/bar"], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects an argument without a slash", () => {
    const result = runScript(h.mainDir, ["feat"], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("rejects a missing argument", () => {
    const result = runScript(h.mainDir, [], h.fakeBun);

    expect(result.exitCode).toBe(2);
  });

  test("prints the usage to stderr on a bad argument", () => {
    const result = runScript(h.mainDir, ["wip/foo"], h.fakeBun);

    expect(result.stderr).toContain("usage:");
  });

  test("prints nothing to stdout on a bad argument", () => {
    const result = runScript(h.mainDir, ["wip/foo"], h.fakeBun);

    expect(result.stdout).toBe("");
  });

  test("creates the branch named type/name", () => {
    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(git(target(), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "feat/foo",
    );
  });

  test("names the directory type-name under .claude/worktrees", () => {
    runScript(h.mainDir, ["docs/bar-baz"], h.fakeBun);

    expect(
      existsSync(
        join(h.mainDir, ".claude", "worktrees", "docs-bar-baz", ".git"),
      ),
    ).toBe(true);
  });

  test("accepts every allowed type", () => {
    const types = ["feat", "fix", "docs", "refactor", "test", "chore"];

    const exitCodes = types.map(
      (type) => runScript(h.mainDir, [`${type}/x1`], h.fakeBun).exitCode,
    );

    expect(exitCodes).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("branches from the fetched origin/main, not the local main", () => {
    const originHead = advanceOrigin();

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(git(target(), ["rev-parse", "HEAD"])).toBe(originHead);
  });

  test("does not track origin/main", () => {
    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    const result = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "feat/foo@{upstream}"],
      { cwd: h.mainDir, env: cleanEnv() },
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("creates the worktree under the main checkout when run from the main checkout", () => {
    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("creates the worktree under the main checkout when run from another worktree", () => {
    runScript(h.mainDir, ["fix/first"], h.fakeBun);
    const first = join(h.mainDir, ".claude", "worktrees", "fix-first");

    const result = runScript(first, ["feat/foo"], h.fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("does not nest a worktree inside the worktree it runs from", () => {
    runScript(h.mainDir, ["fix/first"], h.fakeBun);
    const first = join(h.mainDir, ".claude", "worktrees", "fix-first");

    runScript(first, ["feat/foo"], h.fakeBun);

    expect(existsSync(join(first, ".claude"))).toBe(false);
  });

  test("creates the worktree when run from a subdirectory of the main checkout", () => {
    const sub = join(h.mainDir, "sub");
    mkdirSync(sub);

    const result = runScript(sub, ["feat/foo"], h.fakeBun);

    expect(result.stdout.trim().split("\n").pop()).toBe(target());
  });

  test("prints only the absolute path to stdout", () => {
    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.stdout).toBe(`${target()}\n`);
  });

  test("exits with zero on success", () => {
    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).toBe(0);
  });

  test("installs root and console dependencies inside the new worktree", () => {
    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(readFileSync(h.bunLog, "utf8").trim().split("\n")).toEqual([
      `${target()} install --frozen-lockfile --ignore-scripts`,
      `${target()} install --cwd console --frozen-lockfile --ignore-scripts`,
    ]);
  });

  test("fails when the install fails", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("runs the install before the install failure", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(h.bunLog)).toBe(true);
  });

  test("removes the worktree directory when the install fails", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("removes the branch when the install fails", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("unregisters the worktree when the install fails", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(git(h.mainDir, ["worktree", "list", "--porcelain"])).not.toContain(
      "feat-foo",
    );
  });

  test("tells how to rerun when the install fails", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.stderr).toContain("Fix the cause and rerun");
  });

  test("succeeds when rerun with the same argument after an install failure", () => {
    writeFakeBun(h.fakeBun, h.bunLog, 1);
    runScript(h.mainDir, ["feat/foo"], h.fakeBun);
    writeFakeBun(h.fakeBun, h.bunLog, 0);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).toBe(0);
  });

  test("keeps a pre-existing worktree of another name when the install fails", () => {
    runScript(h.mainDir, ["fix/first"], h.fakeBun);
    writeFakeBun(h.fakeBun, h.bunLog, 1);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(
      existsSync(join(h.mainDir, ".claude", "worktrees", "fix-first", ".git")),
    ).toBe(true);
  });

  test("prints the first push command to stderr on success", () => {
    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.stderr).toContain("git push -u origin HEAD");
  });

  test("fails when the branch already exists on origin", () => {
    git(h.mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("does not create the directory when the branch exists on origin", () => {
    git(h.mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("does not create the local branch when the branch exists on origin", () => {
    git(h.mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("fails when the fetch fails", () => {
    git(h.mainDir, [
      "remote",
      "set-url",
      "origin",
      join(h.root, "missing.git"),
    ]);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("does not create the directory when the fetch fails", () => {
    git(h.mainDir, [
      "remote",
      "set-url",
      "origin",
      join(h.root, "missing.git"),
    ]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("does not create the branch when the fetch fails", () => {
    git(h.mainDir, [
      "remote",
      "set-url",
      "origin",
      join(h.root, "missing.git"),
    ]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(branchExists("feat/foo")).toBe(false);
  });

  test("fails when run from a bare repository", () => {
    const result = runScript(h.originDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).toBe(1);
  });

  test("creates nothing next to a bare repository", () => {
    runScript(h.originDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(join(h.root, ".claude"))).toBe(false);
  });

  describe("when the plain worktree remove is refused", () => {
    // gitignoreに載らない新規のファイルがあると、通常のremoveは拒まれる。
    beforeEach(() => {
      writeFakeBun(h.fakeBun, h.bunLog, 3, "echo x > untracked.txt");
    });

    test("keeps the exit code of the failed install", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.exitCode).toBe(3);
    });

    test("keeps the worktree directory", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(existsSync(join(target(), "untracked.txt"))).toBe(true);
    });

    test("keeps the branch", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(branchExists("feat/foo")).toBe(true);
    });

    test("tells how to check the contents", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.stderr).toContain("git status --short");
    });

    test("does not suggest forcing in its own guidance", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      // gitが自分で出す`fatal:`の行は、スクリプトの案内ではないので除く。
      const own = result.stderr
        .split("\n")
        .filter((line) => !line.startsWith("fatal:"));
      expect(own.join("\n")).not.toContain("--force");
    });

    test("does not suggest deleting the branch by force in the guidance", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.stderr).not.toContain("branch -D");
    });
  });

  describe("when the branch has moved on from the start commit", () => {
    beforeEach(() => {
      writeFakeBun(
        h.fakeBun,
        h.bunLog,
        1,
        "git commit --quiet --allow-empty --no-gpg-sign -m extra",
      );
    });

    test("keeps the branch", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(branchExists("feat/foo")).toBe(true);
    });

    test("removes the worktree", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(existsSync(target())).toBe(false);
    });

    test("tells that the branch remains", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.stderr).toContain("branch feat/foo remains");
    });
  });

  describe("when the origin check fails after a successful fetch", () => {
    let fakeBin: string;

    beforeEach(() => {
      fakeBin = join(h.root, "fakebin");
      mkdirSync(fakeBin);
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash\nif [ "$1" = "ls-remote" ]; then echo "fatal: fake failure" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(fakeBin, "git"), 0o755);
    });

    const withFakeGit = () => ({
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });

    test("fails", () => {
      const result = runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        withFakeGit(),
      );

      expect(result.exitCode).toBe(1);
    });

    test("does not create the directory", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, withFakeGit());

      expect(existsSync(target())).toBe(false);
    });

    test("does not create the branch", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, withFakeGit());

      expect(branchExists("feat/foo")).toBe(false);
    });
  });

  test("keeps the finished worktree when stdout is closed", () => {
    runScript(h.mainDir, ["feat/foo"], h.fakeBun, { closeStdout: true });

    expect(existsSync(join(target(), "node_modules", "marker"))).toBe(true);
  });

  test("keeps the branch when stdout is closed", () => {
    runScript(h.mainDir, ["feat/foo"], h.fakeBun, { closeStdout: true });

    expect(branchExists("feat/foo")).toBe(true);
  });

  describe("when interrupted during the install", () => {
    // 偽のbunがスクリプトにINTを送り、子が終わった後にtrapが働く。
    beforeEach(() => {
      writeFakeBun(h.fakeBun, h.bunLog, 0, 'kill -INT "$PPID"\nsleep 0.5');
    });

    test("exits with 130", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.exitCode).toBe(130);
    });

    test("removes the worktree directory", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(existsSync(target())).toBe(false);
    });

    test("removes the branch", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(branchExists("feat/foo")).toBe(false);
    });

    test("does not run the second install", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(readFileSync(h.bunLog, "utf8").trim().split("\n")).toHaveLength(1);
    });
  });

  describe("when git worktree add itself fails", () => {
    // post-checkoutのフックが失敗すると、worktreeを作った後で`git worktree add`が失敗する。
    beforeEach(() => {
      const hook = join(h.mainDir, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
    });

    test("fails", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.exitCode).toBe(1);
    });

    test("removes nothing", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(existsSync(target())).toBe(true);
    });

    test("tells that nothing was removed", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(result.stderr).toContain("nothing was removed");
    });

    test("does not run the install", () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun);

      expect(existsSync(h.bunLog)).toBe(false);
    });
  });

  test("fails when the branch already exists", () => {
    git(h.mainDir, ["branch", "feat/foo"]);

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("leaves the existing branch untouched", () => {
    git(h.mainDir, ["branch", "feat/foo"]);
    const before = git(h.mainDir, ["rev-parse", "feat/foo"]);
    advanceOrigin();

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(git(h.mainDir, ["rev-parse", "feat/foo"])).toBe(before);
  });

  test("does not create the directory when the branch already exists", () => {
    git(h.mainDir, ["branch", "feat/foo"]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(target())).toBe(false);
  });

  test("fails when the directory already exists", () => {
    mkdirSync(target(), { recursive: true });

    const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(result.exitCode).not.toBe(0);
  });

  test("leaves the existing directory contents untouched", () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "keep.txt"), "keep\n");

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(readFileSync(join(target(), "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("does not create the branch when the directory already exists", () => {
    mkdirSync(target(), { recursive: true });

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", "refs/heads/feat/foo"],
      { cwd: h.mainDir, env: cleanEnv() },
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("does not run the install when it refuses to create the worktree", () => {
    git(h.mainDir, ["branch", "feat/foo"]);

    runScript(h.mainDir, ["feat/foo"], h.fakeBun);

    expect(existsSync(h.bunLog)).toBe(false);
  });
});
