import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

type Run = {
  exitCode: number;
  stdout: string;
  stderr: string;
  // スクリプトを起動してから、標準出力と標準エラーが閉じて終了するまでの時間(ミリ秒)。
  elapsedMs: number;
};

type RunOptions = {
  // 環境変数の追加。PATHの先頭に偽のgitを置くときなどに使う。
  env?: Record<string, string>;
  // 環境変数から取り除く名前。
  unset?: string[];
  // trueなら、標準出力を閉じた状態でスクリプトを起動する。
  closeStdout?: boolean;
  // 標準入力に渡す文字列。フックのJSONに使う。
  input?: string;
};

const BASH = Bun.which("bash") ?? "bash";

// テストごとに作る空のHOME。
let fakeHome = "";

function runScript(
  cwd: string,
  args: string[],
  bun: string,
  options: RunOptions = {},
): Run {
  const command = options.closeStdout
    ? [BASH, "-c", 'bash "$0" "$@" >&-', SCRIPT, ...args]
    : [BASH, SCRIPT, ...args];
  const env: Record<string, string> = {
    ...cleanEnv(),
    // 利用者のClaude設定(`~/.claude/settings.json`)を読ませない。
    HOME: fakeHome,
    WORKTREE_NEW_EXTRA_PATH: "",
    WORKTREE_NEW_BUN: bun,
    // 既定では、自動の片付けを起動させない。起動を確かめるテストだけが`1`にする。
    WORKTREE_AUTO_PRUNE: "0",
    ...options.env,
  };
  for (const name of options.unset ?? []) {
    delete env[name];
  }
  const startedAt = Date.now();
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: Buffer.from(options.input ?? ""),
    env,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    elapsedMs: Date.now() - startedAt,
  };
}

// macOSの/var/foldersは/private/varへのリンクなので、実パスにそろえる。
function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// 呼ばれた作業ディレクトリと引数を1行ずつ記録し、本物と同じく`node_modules`を作るだけのbun。
// `extra`は終了の直前に実行するシェルの行で、worktreeに追加のファイルやコミットを作るのに使う。
function writeFakeBun(
  path: string,
  log: string,
  exitCode: number,
  extra = "",
): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$PWD $*" >> "${log}"\nmkdir -p node_modules\ntouch node_modules/marker\n${extra}\nexit ${exitCode}\n`,
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
    fakeHome = join(root, "home");
    mkdirSync(fakeHome);
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

    expect(result.stderr).toContain("Fix the cause and rerun");
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

  describe("when the plain worktree remove is refused", () => {
    // gitignoreに載らない新規のファイルがあると、通常のremoveは拒まれる。
    beforeEach(() => {
      writeFakeBun(fakeBun, bunLog, 3, "echo x > untracked.txt");
    });

    test("keeps the exit code of the failed install", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.exitCode).toBe(3);
    });

    test("keeps the worktree directory", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(existsSync(join(target(), "untracked.txt"))).toBe(true);
    });

    test("keeps the branch", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(branchExists("feat/foo")).toBe(true);
    });

    test("tells how to check the contents", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.stderr).toContain("git status --short");
    });

    test("does not suggest forcing in its own guidance", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      // gitが自分で出す`fatal:`の行は、スクリプトの案内ではないので除く。
      const own = result.stderr
        .split("\n")
        .filter((line) => !line.startsWith("fatal:"));
      expect(own.join("\n")).not.toContain("--force");
    });

    test("does not suggest deleting the branch by force in the guidance", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.stderr).not.toContain("branch -D");
    });
  });

  describe("when the branch has moved on from the start commit", () => {
    beforeEach(() => {
      writeFakeBun(
        fakeBun,
        bunLog,
        1,
        "git commit --quiet --allow-empty --no-gpg-sign -m extra",
      );
    });

    test("keeps the branch", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(branchExists("feat/foo")).toBe(true);
    });

    test("removes the worktree", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(existsSync(target())).toBe(false);
    });

    test("tells that the branch remains", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.stderr).toContain("branch feat/foo remains");
    });
  });

  describe("when the origin check fails after a successful fetch", () => {
    let fakeBin: string;

    beforeEach(() => {
      fakeBin = join(root, "fakebin");
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
      const result = runScript(mainDir, ["feat/foo"], fakeBun, withFakeGit());

      expect(result.exitCode).toBe(1);
    });

    test("does not create the directory", () => {
      runScript(mainDir, ["feat/foo"], fakeBun, withFakeGit());

      expect(existsSync(target())).toBe(false);
    });

    test("does not create the branch", () => {
      runScript(mainDir, ["feat/foo"], fakeBun, withFakeGit());

      expect(branchExists("feat/foo")).toBe(false);
    });
  });

  test("keeps the finished worktree when stdout is closed", () => {
    runScript(mainDir, ["feat/foo"], fakeBun, { closeStdout: true });

    expect(existsSync(join(target(), "node_modules", "marker"))).toBe(true);
  });

  test("keeps the branch when stdout is closed", () => {
    runScript(mainDir, ["feat/foo"], fakeBun, { closeStdout: true });

    expect(branchExists("feat/foo")).toBe(true);
  });

  describe("when interrupted during the install", () => {
    // 偽のbunがスクリプトにINTを送り、子が終わった後にtrapが働く。
    beforeEach(() => {
      writeFakeBun(fakeBun, bunLog, 0, 'kill -INT "$PPID"\nsleep 0.5');
    });

    test("exits with 130", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.exitCode).toBe(130);
    });

    test("removes the worktree directory", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(existsSync(target())).toBe(false);
    });

    test("removes the branch", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(branchExists("feat/foo")).toBe(false);
    });

    test("does not run the second install", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(readFileSync(bunLog, "utf8").trim().split("\n")).toHaveLength(1);
    });
  });

  describe("when git worktree add itself fails", () => {
    // post-checkoutのフックが失敗すると、worktreeを作った後で`git worktree add`が失敗する。
    beforeEach(() => {
      const hook = join(mainDir, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
    });

    test("fails", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.exitCode).toBe(1);
    });

    test("removes nothing", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(existsSync(target())).toBe(true);
    });

    test("tells that nothing was removed", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun);

      expect(result.stderr).toContain("nothing was removed");
    });

    test("does not run the install", () => {
      runScript(mainDir, ["feat/foo"], fakeBun);

      expect(existsSync(bunLog)).toBe(false);
    });
  });

  describe("--hook", () => {
    const worktrees = () => join(mainDir, ".claude", "worktrees");

    function runHook(
      name: unknown,
      options: RunOptions = {},
      cwd: string = mainDir,
      jsonCwd: string = mainDir,
    ): Run {
      return runScript(cwd, ["--hook"], fakeBun, {
        input: JSON.stringify({ name, cwd: jsonCwd }),
        ...options,
      });
    }

    // name, ブランチ名, ディレクトリ名
    const MAPPING: [unknown, string, string][] = [
      ["feat-foo", "feat/foo", "feat-foo"],
      ["feat/foo", "feat/foo", "feat-foo"],
      ["Feat/Foo", "feat/foo", "feat-foo"],
      ["docs-bar-baz", "docs/bar-baz", "docs-bar-baz"],
      ["chore-x", "chore/x", "chore-x"],
      ["bold-oak-a3f2", "worktree-bold-oak-a3f2", "bold-oak-a3f2"],
      ["agent-ab12cd", "worktree-agent-ab12cd", "agent-ab12cd"],
      ["feature-x", "worktree-feature-x", "feature-x"],
      ["feat", "worktree-feat", "feat"],
      ["feat-", "worktree-feat", "feat"],
      ["  Foo  Bar!! ", "worktree-foo-bar", "foo-bar"],
      ["a/../b", "worktree-a-b", "a-b"],
      ["../../etc", "worktree-etc", "etc"],
      ["a__b..c", "worktree-a-b-c", "a-b-c"],
    ];

    test.each(MAPPING)("maps the name %j to the branch", (name, branch) => {
      const result = runHook(name);

      expect(
        git(result.stdout.trim(), ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).toBe(branch);
    });

    test.each(MAPPING)(
      "maps the name %j to the directory",
      (name, _branch, dir) => {
        const result = runHook(name);

        expect(result.stdout).toBe(`${join(worktrees(), dir)}\n`);
      },
    );

    test.each([["///"], [""], ["テスト"], ["--"], [".."], [42], [null]])(
      "rejects the unusable name %j with 2",
      (name) => {
        const result = runHook(name);

        expect(result.exitCode).toBe(2);
      },
    );

    test("creates nothing for an unusable name", () => {
      runHook("///");

      expect(existsSync(join(mainDir, ".claude"))).toBe(false);
    });

    test("rejects input that is not JSON with 2", () => {
      const result = runScript(mainDir, ["--hook"], fakeBun, {
        input: "not json",
      });

      expect(result.exitCode).toBe(2);
    });

    test("rejects input without a name with 2", () => {
      const result = runScript(mainDir, ["--hook"], fakeBun, {
        input: JSON.stringify({ cwd: mainDir }),
      });

      expect(result.exitCode).toBe(2);
    });

    test("fails with a clear reason when jq is not in PATH", () => {
      const emptyBin = join(root, "emptybin");
      mkdirSync(emptyBin);

      const result = runHook("feat-foo", { env: { PATH: emptyBin } });

      expect(result.stderr).toContain("jq is required");
    });

    test("exits with 1 when jq is not in PATH", () => {
      const emptyBin = join(root, "emptybin");
      mkdirSync(emptyBin);

      const result = runHook("feat-foo", { env: { PATH: emptyBin } });

      expect(result.exitCode).toBe(1);
    });

    test("prints only the path to stdout even when the install prints", () => {
      writeFakeBun(fakeBun, bunLog, 0, "echo noise from bun");

      const result = runHook("feat-foo");

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });

    test("uses the cwd of the input to find the main checkout", () => {
      const result = runHook("feat-foo", {}, root);

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });

    test("installs the dependencies inside the new worktree", () => {
      runHook("feat-foo");

      expect(readFileSync(bunLog, "utf8").trim().split("\n")).toHaveLength(2);
    });

    test("branches from the fetched origin/main", () => {
      const originHead = advanceOrigin();

      const result = runHook("feat-foo");

      expect(git(result.stdout.trim(), ["rev-parse", "HEAD"])).toBe(originHead);
    });

    test("continues with a warning when the fetch fails", () => {
      git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);

      const result = runHook("feat-foo");

      expect(result.stderr).toContain("warning: fetch failed");
    });

    test("succeeds when the fetch fails but origin/main is known", () => {
      git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(0);
    });

    test("fails when the fetch fails and origin/main is unknown", () => {
      git(mainDir, ["remote", "set-url", "origin", join(root, "missing.git")]);
      git(mainDir, ["update-ref", "-d", "refs/remotes/origin/main"]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("continues with a warning when the origin check fails", () => {
      const fakeBin = join(root, "fakebin");
      mkdirSync(fakeBin);
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash\nif [ "$1" = "ls-remote" ]; then exit 128; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(fakeBin, "git"), 0o755);

      const result = runHook("feat-foo", {
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });

      expect(result.exitCode).toBe(0);
    });

    test("fails when the branch exists on origin", () => {
      git(mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("fails when the directory already exists", () => {
      mkdirSync(join(worktrees(), "feat-foo"), { recursive: true });

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("removes the worktree when the install fails", () => {
      writeFakeBun(fakeBun, bunLog, 1);

      runHook("feat-foo");

      expect(existsSync(join(worktrees(), "feat-foo"))).toBe(false);
    });

    test("prints nothing to stdout when the install fails", () => {
      writeFakeBun(fakeBun, bunLog, 1);

      const result = runHook("feat-foo");

      expect(result.stdout).toBe("");
    });

    function writeSettings(dir: string, file: string, content: string): void {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", file), content);
    }

    const baseRef = (value: unknown) =>
      JSON.stringify({ worktree: { baseRef: value } });

    // メインのcheckoutだけに、originにpushしていないcommitを足してshaを返す。
    function localCommit(): string {
      git(mainDir, [
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "local",
      ]);
      return git(mainDir, ["rev-parse", "HEAD"]);
    }

    describe("worktree.baseRef", () => {
      let local: string;
      let originHead: string;

      beforeEach(() => {
        originHead = git(mainDir, ["rev-parse", "HEAD"]);
        local = localCommit();
      });

      const headOf = (result: Run) =>
        git(result.stdout.trim(), ["rev-parse", "HEAD"]);

      test("branches from HEAD when the project settings say head", () => {
        writeSettings(mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("does not fetch when it branches from HEAD", () => {
        writeSettings(mainDir, "settings.json", baseRef("head"));

        const result = runHook("feat-foo");

        expect(result.stderr).not.toContain("fetching origin/main");
      });

      test("branches from origin/main when the setting is fresh", () => {
        writeSettings(mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is absent", () => {
        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is an unknown string", () => {
        writeSettings(mainDir, "settings.json", baseRef("branch"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is a number", () => {
        writeSettings(mainDir, "settings.json", baseRef(5));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the settings file is broken", () => {
        writeSettings(mainDir, "settings.json", "{ not json");

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("still succeeds when the settings file is broken", () => {
        writeSettings(mainDir, "settings.json", "{ not json");

        expect(runHook("feat-foo").exitCode).toBe(0);
      });

      test("skips a broken local settings file and reads the next one", () => {
        writeSettings(mainDir, "settings.local.json", "{ not json");
        writeSettings(mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("prefers settings.local.json over settings.json", () => {
        writeSettings(mainDir, "settings.local.json", baseRef("fresh"));
        writeSettings(mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("prefers a local head over a project fresh", () => {
        writeSettings(mainDir, "settings.local.json", baseRef("head"));
        writeSettings(mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("reads the user settings when the project has none", () => {
        writeSettings(fakeHome, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("prefers the project settings over the user settings", () => {
        writeSettings(fakeHome, "settings.json", baseRef("head"));
        writeSettings(mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      // 最初のworktreeを作った後でoriginを進めて、HEADから作ることとorigin/mainから作ることを区別する。
      function firstWorktreeThenAdvanceOrigin(): {
        first: string;
        firstHead: string;
        newOrigin: string;
      } {
        runScript(mainDir, ["fix/first"], fakeBun);
        const first = join(worktrees(), "fix-first");
        const firstHead = git(first, ["rev-parse", "HEAD"]);
        return { first, firstHead, newOrigin: advanceOrigin() };
      }

      test("ignores the settings of the hook cwd", () => {
        const { first, newOrigin } = firstWorktreeThenAdvanceOrigin();
        writeSettings(first, "settings.json", baseRef("head"));
        writeSettings(mainDir, "settings.json", baseRef("fresh"));

        const result = runHook("feat-foo", {}, mainDir, first);

        expect(headOf(result)).toBe(newOrigin);
      });

      test("ignores the local settings of the hook cwd", () => {
        const { first, newOrigin } = firstWorktreeThenAdvanceOrigin();
        writeSettings(first, "settings.local.json", baseRef("head"));

        const result = runHook("feat-foo", {}, mainDir, first);

        expect(headOf(result)).toBe(newOrigin);
      });

      test("branches from the HEAD of the hook cwd when the main settings say head", () => {
        const { first, firstHead } = firstWorktreeThenAdvanceOrigin();
        writeSettings(mainDir, "settings.json", baseRef("head"));

        const result = runHook("feat-foo", {}, mainDir, first);

        expect(headOf(result)).toBe(firstHead);
      });
    });

    describe("reusing an existing worktree", () => {
      test("succeeds on the second call with the same name", () => {
        runHook("feat-foo");

        expect(runHook("feat-foo").exitCode).toBe(0);
      });

      test("prints the same path on the second call", () => {
        runHook("feat-foo");

        expect(runHook("feat-foo").stdout).toBe(
          `${join(worktrees(), "feat-foo")}\n`,
        );
      });

      test("installs the dependencies again on the second call", () => {
        runHook("feat-foo");

        runHook("feat-foo");

        expect(readFileSync(bunLog, "utf8").trim().split("\n")).toHaveLength(4);
      });

      test("fails when the install fails on reuse", () => {
        runHook("feat-foo");
        writeFakeBun(fakeBun, bunLog, 1);

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      test("keeps the reused worktree when the install fails", () => {
        runHook("feat-foo");
        writeFakeBun(fakeBun, bunLog, 1);

        runHook("feat-foo");

        expect(existsSync(join(worktrees(), "feat-foo", ".git"))).toBe(true);
      });

      test("keeps the branch of the reused worktree when the install fails", () => {
        runHook("feat-foo");
        writeFakeBun(fakeBun, bunLog, 1);

        runHook("feat-foo");

        expect(git(mainDir, ["branch", "--list", "feat/foo"])).toContain(
          "feat/foo",
        );
      });

      test("prints nothing to stdout when the install fails on reuse", () => {
        runHook("feat-foo");
        writeFakeBun(fakeBun, bunLog, 1);

        expect(runHook("feat-foo").stdout).toBe("");
      });

      test("fails when the worktree at the path has another branch", () => {
        git(mainDir, [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "other",
          join(worktrees(), "feat-foo"),
        ]);

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      test("fails when the directory is not a registered worktree", () => {
        mkdirSync(join(worktrees(), "feat-foo"), { recursive: true });

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      describe("when only the branch exists", () => {
        let branchSha: string;

        beforeEach(() => {
          branchSha = git(mainDir, ["rev-parse", "HEAD"]);
          git(mainDir, [
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "branch tip",
          ]);
          branchSha = git(mainDir, ["rev-parse", "HEAD"]);
          git(mainDir, ["branch", "feat/foo", branchSha]);
        });

        test("checks out the existing branch in the hook mode", () => {
          const result = runHook("feat-foo");

          expect(
            git(result.stdout.trim(), ["rev-parse", "--abbrev-ref", "HEAD"]),
          ).toBe("feat/foo");
        });

        test("keeps the commit of the existing branch", () => {
          const result = runHook("feat-foo");

          expect(git(result.stdout.trim(), ["rev-parse", "HEAD"])).toBe(
            branchSha,
          );
        });

        test("installs the dependencies", () => {
          runHook("feat-foo");

          expect(readFileSync(bunLog, "utf8").trim().split("\n")).toHaveLength(
            2,
          );
        });

        test("removes only the worktree and keeps the branch when the install fails", () => {
          writeFakeBun(fakeBun, bunLog, 1);

          runHook("feat-foo");

          expect([
            existsSync(join(worktrees(), "feat-foo")),
            git(mainDir, ["branch", "--list", "feat/foo"]).includes("feat/foo"),
          ]).toEqual([false, true]);
        });

        test("fails when another worktree has the branch checked out", () => {
          git(mainDir, [
            "worktree",
            "add",
            "--quiet",
            join(root, "elsewhere"),
            "feat/foo",
          ]);

          expect(runHook("feat-foo").exitCode).toBe(1);
        });

        test("does not create the directory when git refuses the checkout", () => {
          git(mainDir, [
            "worktree",
            "add",
            "--quiet",
            join(root, "elsewhere"),
            "feat/foo",
          ]);

          runHook("feat-foo");

          expect(existsSync(join(worktrees(), "feat-foo"))).toBe(false);
        });
      });

      test("fails in the argument mode when only the branch exists", () => {
        git(mainDir, ["branch", "feat/foo"]);

        expect(runScript(mainDir, ["feat/foo"], fakeBun).exitCode).toBe(1);
      });

      test("fails in the argument mode on the second call", () => {
        runScript(mainDir, ["feat/foo"], fakeBun);

        expect(runScript(mainDir, ["feat/foo"], fakeBun).exitCode).toBe(1);
      });
    });

    describe("PATH and bun", () => {
      // 偽のbunかmiseを、`name`の名前で`dir`に置く。
      function fakeTool(dir: string, name: string): void {
        mkdirSync(dir, { recursive: true });
        writeFakeBun(join(dir, name), bunLog, 0);
      }

      test("runs the install through mise when it is found", () => {
        const extra = join(root, "extra");
        fakeTool(extra, "mise");

        runHook("feat-foo", {
          env: { WORKTREE_NEW_BUN: "", WORKTREE_NEW_EXTRA_PATH: extra },
        });

        expect(readFileSync(bunLog, "utf8").trim().split("\n")).toEqual([
          `${join(worktrees(), "feat-foo")} exec -- bun install --frozen-lockfile --ignore-scripts`,
          `${join(worktrees(), "feat-foo")} exec -- bun install --cwd console --frozen-lockfile --ignore-scripts`,
        ]);
      });

      test("lets WORKTREE_NEW_BUN win over mise", () => {
        const extra = join(root, "extra");
        fakeTool(extra, "mise");

        runHook("feat-foo", { env: { WORKTREE_NEW_EXTRA_PATH: extra } });

        expect(readFileSync(bunLog, "utf8").trim().split("\n")[0]).toBe(
          `${join(worktrees(), "feat-foo")} install --frozen-lockfile --ignore-scripts`,
        );
      });

      // miseを含まないPATHを、必要な道具のリンクだけで作る。
      function toolOnlyPath(withBun: boolean): string {
        const bin = join(root, "toolbin");
        mkdirSync(bin);
        const tools = [
          "bash",
          "git",
          "jq",
          "tr",
          "sed",
          "cat",
          "dirname",
          "basename",
          "env",
          "mkdir",
          "touch",
        ];
        for (const tool of tools) {
          symlinkSync(Bun.which(tool) ?? "/nonexistent", join(bin, tool));
        }
        if (withBun) {
          fakeTool(bin, "bun");
        }
        return bin;
      }

      test("runs bun directly when mise is absent", () => {
        const bin = toolOnlyPath(true);

        runHook("feat-foo", { env: { PATH: bin, WORKTREE_NEW_BUN: "" } });

        expect(readFileSync(bunLog, "utf8").trim().split("\n")[0]).toBe(
          `${join(worktrees(), "feat-foo")} install --frozen-lockfile --ignore-scripts`,
        );
      });

      test("fails with a reason when neither mise nor bun is found", () => {
        const bin = toolOnlyPath(false);

        const result = runHook("feat-foo", {
          env: { PATH: bin, WORKTREE_NEW_BUN: "" },
        });

        expect(result.stderr).toContain("bun is required");
      });

      test("creates nothing when bun is not found", () => {
        const bin = toolOnlyPath(false);

        runHook("feat-foo", { env: { PATH: bin, WORKTREE_NEW_BUN: "" } });

        expect(existsSync(join(mainDir, ".claude"))).toBe(false);
      });
    });

    describe("network limits", () => {
      let gitLog: string;
      let fakeBin: string;

      beforeEach(() => {
        gitLog = join(root, "git.log");
        fakeBin = join(root, "fakebin");
        mkdirSync(fakeBin);
        const realGit = Bun.which("git") ?? "git";
        writeFileSync(
          join(fakeBin, "git"),
          `#!/usr/bin/env bash\necho "args=$* ssh=\${GIT_SSH_COMMAND:-}" >> "${gitLog}"\nexec "${realGit}" "$@"\n`,
        );
        chmodSync(join(fakeBin, "git"), 0o755);
      });

      const withFakeGit = (extra: Record<string, string> = {}) => ({
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ...extra },
      });

      const SSH_OPTION = "core.sshCommand=ssh -o ConnectTimeout=15";

      test("sets a low speed limit for fetch in the hook mode", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toMatch(
          /-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 .*fetch/,
        );
      });

      test("sets a low speed limit for ls-remote in the hook mode", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toMatch(
          /-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 .*ls-remote/,
        );
      });

      test("passes a connect timeout for ssh to git when none is configured", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toContain(
          `-c ${SSH_OPTION} -o BatchMode=yes`,
        );
      });

      test("does not export GIT_SSH_COMMAND to git", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain("ssh=ssh");
      });

      test("does not pass GIT_SSH_COMMAND to the install", () => {
        const envLog = join(root, "bun-env.log");
        writeFakeBun(
          fakeBun,
          bunLog,
          0,
          `echo "ssh=\${GIT_SSH_COMMAND:-}" >> "${envLog}"`,
        );

        runHook("feat-foo");

        expect(readFileSync(envLog, "utf8")).toBe("ssh=\nssh=\n");
      });

      test("keeps the core.sshCommand of the user", () => {
        git(mainDir, ["config", "core.sshCommand", "myssh"]);

        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("keeps a GIT_SSH_COMMAND that is already set", () => {
        runHook("feat-foo", withFakeGit({ GIT_SSH_COMMAND: "myssh" }));

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("keeps a GIT_SSH that is already set", () => {
        runHook("feat-foo", withFakeGit({ GIT_SSH: "myssh" }));

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("does not add the limits in the argument mode", () => {
        runScript(mainDir, ["feat/foo"], fakeBun, withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain("lowSpeed");
      });
    });

    test("prints the real path when the cwd is a symbolic link to the main checkout", () => {
      const link = join(root, "link-to-main");
      symlinkSync(mainDir, link);

      const result = runHook("feat-foo", {}, link, link);

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });
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

  describe("automatic prune", () => {
    // 起動された片付けのスクリプトが、cwd、引数、PATHを記録する場所。
    let record: string;
    let pruneStub: string;

    // 偽の片付け。記録してから数秒眠る。眠る間に、起動した側が待たないことを確かめる。
    function writePruneStub(path: string, body = "sleep 4"): void {
      writeFileSync(
        path,
        `#!/usr/bin/env bash\n{ echo "$PWD"; echo "$*"; echo "$PATH"; } > "${record}.tmp"\nmv "${record}.tmp" "${record}"\n${body}\n`,
      );
    }

    // 起動の環境変数。`WORKTREE_AUTO_PRUNE`は`1`にして偽の片付けを使わせる。
    function startEnv(extra: Record<string, string> = {}): RunOptions {
      return {
        env: {
          WORKTREE_AUTO_PRUNE: "1",
          WORKTREE_NEW_PRUNE_SCRIPT: pruneStub,
          ...extra,
        },
      };
    }

    // 記録が現れるまで最大`limitMs`待ち、行の配列を返す。現れなければnullを返す。
    async function waitForRecord(limitMs = 3000): Promise<string[] | null> {
      for (let waited = 0; waited < limitMs; waited += 50) {
        if (existsSync(record)) {
          return readFileSync(record, "utf8").trimEnd().split("\n");
        }
        await Bun.sleep(50);
      }
      return null;
    }

    // 起動しないことは、少し待っても記録が現れないことで確かめる。
    async function notStarted(): Promise<boolean> {
      return (await waitForRecord(1000)) === null;
    }

    beforeEach(() => {
      record = join(root, "prune-record");
      pruneStub = join(root, "prune-stub.sh");
      writePruneStub(pruneStub);
    });

    test("starts the automatic prune after creating a worktree", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      const lines = await waitForRecord();

      expect(lines?.[1]).toStartWith("--auto");
    });

    test("starts the automatic prune when WORKTREE_AUTO_PRUNE is unset", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, {
        ...startEnv(),
        unset: ["WORKTREE_AUTO_PRUNE"],
      });

      expect(await waitForRecord()).not.toBeNull();
    });

    test("does not wait for the automatic prune to finish", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      expect(result.elapsedMs).toBeLessThan(3000);
    });

    test("prints only the path to stdout when it starts the prune", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      expect(result.stdout).toBe(`${target()}\n`);
    });

    test("exits with 0 when it starts the prune", () => {
      const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      expect(result.exitCode).toBe(0);
    });

    test("starts it from the caller directory", async () => {
      const caller = join(mainDir, "sub");
      mkdirSync(caller);

      runScript(caller, ["feat/foo"], fakeBun, startEnv());

      expect((await waitForRecord())?.[0]).toBe(caller);
    });

    test("passes the ancestor pids", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      const args = (await waitForRecord())?.[1] ?? "";

      expect(args.split(" ")[2]?.split(",")).toContain(String(process.pid));
    });

    test("passes only digits and commas as the ancestor pids", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      const args = (await waitForRecord())?.[1] ?? "";

      expect(args).toMatch(/^--auto --ancestors [0-9]+(,[0-9]+)*$/);
    });

    test("puts the mise shims at the end of PATH", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      const path = (await waitForRecord())?.[2] ?? "";

      expect(path).toEndWith(`:${fakeHome}/.local/share/mise/shims`);
    });

    test("falls back to the main checkout when the caller directory is gone", async () => {
      const caller = join(mainDir, "sub");
      mkdirSync(caller);
      writeFakeBun(fakeBun, bunLog, 0, `rm -rf "${caller}"`);

      runScript(caller, ["feat/foo"], fakeBun, startEnv());

      expect((await waitForRecord())?.[0]).toBe(mainDir);
    });

    test("succeeds when the caller directory is gone", () => {
      const caller = join(mainDir, "sub");
      mkdirSync(caller);
      writeFakeBun(fakeBun, bunLog, 0, `rm -rf "${caller}"`);

      const result = runScript(caller, ["feat/foo"], fakeBun, startEnv());

      expect(result.stdout).toBe(`${target()}\n`);
    });

    test("does not start for 0", async () => {
      runScript(
        mainDir,
        ["feat/foo"],
        fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "0" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("does not start for an empty value", async () => {
      runScript(
        mainDir,
        ["feat/foo"],
        fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("does not start for false", async () => {
      runScript(
        mainDir,
        ["feat/foo"],
        fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "false" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("defaults WORKTREE_AUTO_PRUNE to 0 in the helper", async () => {
      runScript(mainDir, ["feat/foo"], fakeBun, {
        env: { WORKTREE_NEW_PRUNE_SCRIPT: pruneStub },
      });

      expect(await notStarted()).toBe(true);
    });

    test("does not start when the worktree could not be created", async () => {
      mkdirSync(target(), { recursive: true });

      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      expect(await notStarted()).toBe(true);
    });

    test("does not start when the install fails", async () => {
      writeFakeBun(fakeBun, bunLog, 1);

      runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

      expect(await notStarted()).toBe(true);
    });

    test("warns when the prune script is missing", () => {
      const result = runScript(
        mainDir,
        ["feat/foo"],
        fakeBun,
        startEnv({ WORKTREE_NEW_PRUNE_SCRIPT: join(root, "missing.sh") }),
      );

      expect(result.stderr).toContain("worktree-new: warning: cannot start");
    });

    test("succeeds when the prune script is missing", () => {
      const result = runScript(
        mainDir,
        ["feat/foo"],
        fakeBun,
        startEnv({ WORKTREE_NEW_PRUNE_SCRIPT: join(root, "missing.sh") }),
      );

      expect(result.stdout).toBe(`${target()}\n`);
    });

    describe("failures of earlier runs", () => {
      const stateDir = () => join(mainDir, ".git", "worktree-prune");

      function seedFailures(content: string): void {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(stateDir(), "failures"), content);
      }

      test("warns on stderr after repeated failures", () => {
        seedFailures("3\n");

        const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

        expect(result.stderr).toContain(
          `worktree-new: automatic worktree cleanup failed 3 times in a row; see ${join(stateDir(), "log")}`,
        );
      });

      test("does not print the warning to stdout", () => {
        seedFailures("3\n");

        const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

        expect(result.stdout).toBe(`${target()}\n`);
      });

      test("does not warn after a single failure", () => {
        seedFailures("1\n");

        const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

        expect(result.stderr).not.toContain("automatic worktree cleanup");
      });

      test("does not print a malformed failures value", () => {
        seedFailures("99 boom\n");

        const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

        expect(result.stderr).not.toContain("boom");
      });

      test("does not read failures through a symlink", () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(root, "elsewhere"), "7\n");
        symlinkSync(join(root, "elsewhere"), join(stateDir(), "failures"));

        const result = runScript(mainDir, ["feat/foo"], fakeBun, startEnv());

        expect(result.stderr).not.toContain("automatic worktree cleanup");
      });
    });

    describe("with --hook", () => {
      const hookInput = (jsonCwd: string) =>
        JSON.stringify({ name: "feat-foo", cwd: jsonCwd });

      test("starts the prune from the hook cwd", async () => {
        const jsonCwd = join(mainDir, "sub");
        mkdirSync(jsonCwd);

        runScript(mainDir, ["--hook"], fakeBun, {
          ...startEnv(),
          input: hookInput(jsonCwd),
        });

        expect((await waitForRecord())?.[0]).toBe(jsonCwd);
      });

      test("prints only the path to stdout", () => {
        const result = runScript(mainDir, ["--hook"], fakeBun, {
          ...startEnv(),
          input: hookInput(mainDir),
        });

        expect(result.stdout).toBe(`${target()}\n`);
      });

      test("does not start the automatic prune when reusing a worktree", async () => {
        runScript(mainDir, ["--hook"], fakeBun, {
          input: hookInput(mainDir),
        });

        runScript(mainDir, ["--hook"], fakeBun, {
          ...startEnv(),
          input: hookInput(mainDir),
        });

        expect(await notStarted()).toBe(true);
      });
    });
  });
});
