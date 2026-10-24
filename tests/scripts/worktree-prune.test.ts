import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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

// worktreeの中のファイル(`.git`とnode_modulesを除く)の更新時刻を、`minutes`分前にする。
function ageFiles(dir: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) ageFiles(path, minutes);
    else if (entry.isFile()) utimesSync(path, when, when);
  }
}

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

  function run(
    args: string[] = [],
    cwd: string = mainDir,
    env: Record<string, string> = {},
  ): Run {
    const result = Bun.spawnSync([BASH, SCRIPT, ...args], {
      cwd,
      env: {
        ...cleanEnv(),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        // 偽のlsofを使わせる。本物の絶対パスが優先されるのを避けるため。
        WORKTREE_PRUNE_LSOF: join(fakeBin, "lsof"),
        ...env,
      },
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
    // 既定のrecentの時間(120分)より古く、放置の時間(24時間)より新しいことにする。
    ageFiles(path, 180);
    return path;
  }

  // 偽のlsofが返す出力を差し替える。
  function writeLsof(output: string): void {
    writeFileSync(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash\ncat <<'EOF'\n${output}\nEOF\n`,
    );
    chmodSync(join(fakeBin, "lsof"), 0o755);
  }

  // ブランチのreflogの時刻を、`minutes`分前にそろえる。
  function ageReflog(branch: string, minutes: number): void {
    const file = join(
      mainDir,
      ".git",
      "logs",
      "refs",
      "heads",
      ...branch.split("/"),
    );
    const epoch = Math.floor(Date.now() / 1000) - minutes * 60;
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/> \d+ /g, `> ${epoch} `),
    );
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
    writeLsof("");

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
    writeFileSync(
      join(mainDir, ".gitignore"),
      "node_modules/\n.claude/\n.wmill\n*.local.*\nconsole/dist/\nconsole/.cache/\n__pycache__/\n.DS_Store\n",
    );
    mkdirSync(join(mainDir, "console"));
    writeFileSync(join(mainDir, "console", "package.json"), "{}\n");
    git(mainDir, ["add", "README.md", ".gitignore", "console/package.json"]);
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

    test("rejects an extra argument with 2", () => {
      const result = run(["--apply", "extra"]);

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

  describe("a branch that was created and left alone", () => {
    const DAY = 25 * 60;

    function abandoned(): string {
      const path = addWorktree("docs-aband", "docs/aband");
      ageFiles(path, DAY);
      ageReflog("docs/aband", DAY);
      return path;
    }

    test("is removed as abandoned after 25 hours", () => {
      const path = abandoned();

      const result = run();

      expect(result.stdout).toContain(
        `would remove: ${path} (docs/aband): abandoned`,
      );
    });

    test("loses its worktree with --apply", () => {
      const path = abandoned();

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    // reflogを最後の1行だけにして、`git gc`のreflog expireで古い行が消えた状態を作る。
    // `subject`を渡すと、その1行の件名も差し替える。
    function keepLastReflogLine(branch: string, subject?: string): void {
      const file = join(
        mainDir,
        ".git",
        "logs",
        "refs",
        "heads",
        ...branch.split("/"),
      );
      const lines = readFileSync(file, "utf8").trim().split("\n");
      let last = lines[lines.length - 1] ?? "";
      if (subject !== undefined) {
        last = `${last.split("\t")[0]}\t${subject}`;
      }
      writeFileSync(file, `${last}\n`);
    }

    test("is kept as unused when only the last commit line survives a reflog expire", () => {
      const path = addWorktree("docs-exp", "docs/exp");
      commitIn(path);
      ageFiles(path, DAY);
      ageReflog("docs/exp", DAY);
      keepLastReflogLine("docs/exp");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/exp): unused`);
    });

    test("keeps the unpushed commit with --apply after a reflog expire", () => {
      const path = addWorktree("docs-exp", "docs/exp");
      commitIn(path);
      ageFiles(path, DAY);
      ageReflog("docs/exp", DAY);
      keepLastReflogLine("docs/exp");

      run(["--apply"]);

      expect(branchExists("docs/exp")).toBe(true);
    });

    test("is kept as unused when no other ref contains the commit although the subject says created", () => {
      const path = addWorktree("docs-lone", "docs/lone");
      commitIn(path);
      ageFiles(path, DAY);
      ageReflog("docs/lone", DAY);
      keepLastReflogLine("docs/lone", "branch: Created from HEAD");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/lone): unused`);
    });

    test("is kept as unused when the only line is not a creation record, even if origin/main contains the commit", () => {
      const path = addWorktree("docs-subj", "docs/subj");
      ageFiles(path, DAY);
      ageReflog("docs/subj", DAY);
      keepLastReflogLine("docs/subj", "commit: work");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/subj): unused`);
    });

    test("is removed as abandoned when another ref contains the commit and the line is a creation record", () => {
      const path = addWorktree("docs-both", "docs/both");
      ageFiles(path, DAY);
      ageReflog("docs/both", DAY);
      keepLastReflogLine("docs/both");

      const result = run();

      expect(result.stdout).toContain(
        `would remove: ${path} (docs/both): abandoned`,
      );
    });

    test("is kept as unused after 1 hour", () => {
      const path = addWorktree("docs-aband", "docs/aband");
      ageFiles(path, 60);
      ageReflog("docs/aband", 60);

      const result = run(["--min-idle-minutes", "0"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/aband): unused`);
    });

    test("is kept after 25 hours when it holds an untracked file", () => {
      const path = abandoned();
      writeFileSync(join(path, "notes.txt"), "n\n");

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("is kept as unused after 25 hours when a file changed 5 hours ago", () => {
      const path = abandoned();
      const when = new Date(Date.now() - 5 * 3_600_000);
      utimesSync(join(path, "README.md"), when, when);

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/aband): unused`);
    });
  });

  describe("a merged branch that may be in use", () => {
    let path: string;

    beforeEach(() => {
      path = addMergedWorktree("docs-busy", "docs/busy");
    });

    test("is kept as recent when a file changed within the last 120 minutes", () => {
      const now = new Date();
      utimesSync(join(path, "README.md"), now, now);

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/busy): recent`);
    });

    test("is removed when --min-idle-minutes is 0 despite a fresh file", () => {
      const now = new Date();
      utimesSync(join(path, "README.md"), now, now);

      run(["--apply", "--min-idle-minutes", "0"]);

      expect(existsSync(path)).toBe(false);
    });

    test("is kept as recent with a custom window", () => {
      const when = new Date(Date.now() - 200 * 60_000);
      utimesSync(join(path, "README.md"), when, when);

      const result = run(["--min-idle-minutes", "300"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/busy): recent`);
    });

    test("is kept as in use when a process has its cwd inside", () => {
      writeLsof(`p1234\nn${path}/console`);

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/busy): in use`);
    });

    test("is not removed with --apply while a process has its cwd inside", () => {
      writeLsof(`p1234\nn${path}`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("is removed when the only process cwd is a sibling with the same prefix", () => {
      writeLsof(`p1234\nn${path}-other`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    test("rejects a non-numeric --min-idle-minutes with 2", () => {
      const result = run(["--min-idle-minutes", "abc"]);

      expect(result.exitCode).toBe(2);
    });

    test("rejects --min-idle-minutes without a value with 2", () => {
      const result = run(["--min-idle-minutes"]);

      expect(result.exitCode).toBe(2);
    });
  });

  describe("a merged branch with ignored files", () => {
    let path: string;

    beforeEach(() => {
      path = addMergedWorktree("docs-ign", "docs/ign");
    });

    test("is kept as ignored files when it holds a local secrets file", () => {
      writeFileSync(join(path, "mise.local.toml"), "SECRET=1\n");

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/ign): ignored files`,
      );
    });

    test("keeps the ignored file with --apply", () => {
      writeFileSync(join(path, "mise.local.toml"), "SECRET=1\n");

      run(["--apply"]);

      expect(existsSync(join(path, "mise.local.toml"))).toBe(true);
    });

    test("does not count node_modules and the .wmill link as ignored files", () => {
      mkdirSync(join(path, "node_modules"));
      writeFileSync(join(path, "node_modules", "marker"), "m\n");
      mkdirSync(join(path, "console", "node_modules"), { recursive: true });
      writeFileSync(join(path, "console", "node_modules", "marker"), "m\n");
      symlinkSync(join(mainDir, "README.md"), join(path, ".wmill"));
      ageFiles(path, 180);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });
  });

  describe("a worktree whose reflog holds commits that reset dropped", () => {
    test("is kept even though its tip is an ancestor of origin/main", () => {
      const path = addWorktree("fix-reset", "fix/reset");
      commitIn(path);
      commitIn(path);
      git(path, ["reset", "--quiet", "--hard", "origin/main"]);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (fix/reset): reflog has unreachable commits`,
      );
    });

    test("is not removed with --apply", () => {
      const path = addWorktree("fix-reset", "fix/reset");
      commitIn(path);
      git(path, ["reset", "--quiet", "--hard", "origin/main"]);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("is kept on the squash route when the reset dropped a commit", () => {
      const path = addWorktree("fix-squash-reset", "fix/squash-reset");
      const kept = commitIn(path);
      commitIn(path);
      git(path, ["reset", "--quiet", "--hard", kept]);
      writeGh(`echo ${kept}`);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (fix/squash-reset): reflog has unreachable commits`,
      );
    });

    test("is removable when the reflog of HEAD is missing, since it records nothing to lose", () => {
      const path = addMergedWorktree("fix-nolog", "fix/nolog");
      rmSync(join(mainDir, ".git", "worktrees", "fix-nolog", "logs", "HEAD"));

      const result = run();

      expect(result.stdout).toContain(`would remove: ${path} (fix/nolog)`);
    });
  });

  describe("ignored files", () => {
    test("keeps a real .wmill directory", () => {
      const path = addMergedWorktree("docs-wmill", "docs/wmill");
      mkdirSync(join(path, ".wmill"));
      writeFileSync(join(path, ".wmill", "token"), "t\n");

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/wmill): ignored files`,
      );
    });

    test("does not delete the token of a real .wmill directory with --apply", () => {
      const path = addMergedWorktree("docs-wmill", "docs/wmill");
      mkdirSync(join(path, ".wmill"));
      writeFileSync(join(path, ".wmill", "token"), "t\n");

      run(["--apply"]);

      expect(existsSync(join(path, ".wmill", "token"))).toBe(true);
    });

    test("removes a worktree that holds only regenerable files", () => {
      const path = addMergedWorktree("docs-regen", "docs/regen");
      for (const file of [
        "console/dist/app.js",
        "console/.cache/c.bin",
        "__pycache__/m.pyc",
        "console/__pycache__/n.pyc",
        ".DS_Store",
        "console/.DS_Store",
      ]) {
        mkdirSync(join(path, file, ".."), { recursive: true });
        writeFileSync(join(path, file), "g\n");
      }
      ageFiles(path, 180);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    test("keeps a worktree with a local Claude settings file", () => {
      const path = addMergedWorktree("docs-claude", "docs/claude");
      mkdirSync(join(path, ".claude"));
      writeFileSync(join(path, ".claude", "settings.local.json"), "{}\n");

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/claude): ignored files`,
      );
    });

    test("sees an untracked file although status.showUntrackedFiles is no", () => {
      git(mainDir, ["config", "status.showUntrackedFiles", "no"]);
      const path = addMergedWorktree("docs-untr", "docs/untr");
      writeFileSync(join(path, "notes.txt"), "n\n");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/untr): dirty`);
    });
  });

  describe("an abandoned branch made from a feature branch", () => {
    test("is removed although its base is not an ancestor of origin/main", () => {
      const tree = git(mainDir, ["rev-parse", "origin/main^{tree}"]);
      const featureTip = git(mainDir, [
        "commit-tree",
        tree,
        "-p",
        "origin/main",
        "-m",
        "feature",
      ]);
      git(mainDir, ["branch", "base-feature", featureTip]);
      const path = worktreePath("docs-fb");
      git(mainDir, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "docs/fb",
        path,
        "base-feature",
      ]);
      ageFiles(path, 25 * 60);
      ageReflog("docs/fb", 25 * 60);

      const result = run();

      expect(result.stdout).toContain(
        `would remove: ${path} (docs/fb): abandoned`,
      );
    });
  });

  describe("when lsof returns nothing", () => {
    test("warns that the in use check was skipped", () => {
      writeLsof("");

      const result = run();

      expect(result.stderr).toContain("skipped the in use check");
    });

    test("does not warn when lsof returns the cwd of processes", () => {
      writeLsof(`p1\nn${root}`);

      const result = run();

      expect(result.stderr).not.toContain("skipped the in use check");
    });
  });

  describe("removing the branch", () => {
    test("also removes the upstream settings of the branch", () => {
      addMergedWorktree("docs-up", "docs/up");
      git(mainDir, ["config", "branch.docs/up.remote", "origin"]);
      git(mainDir, ["config", "branch.docs/up.merge", "refs/heads/docs/up"]);

      run(["--apply"]);

      const result = Bun.spawnSync(
        ["git", "config", "--get", "branch.docs/up.remote"],
        { cwd: mainDir, env: cleanEnv() },
      );
      expect(result.exitCode).not.toBe(0);
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

    test("asks gh only for pull requests into main", () => {
      const log = join(root, "gh-args.log");
      writeGh(`echo "$@" > "${log}"\necho ${tip}`);

      run();

      expect(readFileSync(log, "utf8")).toContain("--base main");
    });

    test("is kept as unmerged when the pull request was merged into another base", () => {
      // 積み重ねたPRは、ベースがmainでないので、gh pr listの--base mainに現れない。
      writeGh(
        `base=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--base" ]; then base="$2"; fi\n  shift\ndone\nif [ "$base" = "stack" ]; then echo ${tip}; fi\nexit 0`,
      );

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
      for (const tool of [
        "git",
        "basename",
        "dirname",
        "date",
        "find",
        "cat",
      ]) {
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

    // 判定の後、worktreeを消す直前にブランチが進む。偽のgitが`worktree remove`の前にcommitする。
    function installRacingGit(): void {
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash\nif [ "$1" = worktree ] && [ "$2" = remove ]; then "${realGit}" -C "${path}" commit --quiet --allow-empty --no-gpg-sign -m race; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(fakeBin, "git"), 0o755);
    }

    test("keeps its branch when it moves on between the check and the removal", () => {
      writeGh(`echo ${tip}`);
      installRacingGit();

      run(["--apply"]);

      expect(branchExists("feat/squash")).toBe(true);
    });

    test("tells that the branch remains when it moves on", () => {
      writeGh(`echo ${tip}`);
      installRacingGit();

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

  describe("--auto usage", () => {
    test("--auto rejects --min-idle-minutes", () => {
      const result = run(["--auto", "--min-idle-minutes", "10"]);

      expect(result.exitCode).toBe(2);
    });

    test("--auto rejects --apply", () => {
      const result = run(["--auto", "--apply"]);

      expect(result.exitCode).toBe(2);
    });

    test("--auto rejects --min-idle-minutes given before it", () => {
      const result = run(["--min-idle-minutes", "10", "--auto"]);

      expect(result.exitCode).toBe(2);
    });

    test("--ancestors without --auto is rejected", () => {
      const result = run(["--ancestors", "1"]);

      expect(result.exitCode).toBe(2);
    });

    test("--ancestors without a value is rejected", () => {
      const result = run(["--auto", "--ancestors"]);

      expect(result.exitCode).toBe(2);
    });

    test("--auto with --ancestors is accepted", () => {
      const result = run(["--auto", "--ancestors", "4242"]);

      expect(result.exitCode).toBe(0);
    });

    test("--auto without --ancestors is accepted", () => {
      const result = run(["--auto"]);

      expect(result.exitCode).toBe(0);
    });

    test("--auto accepts an empty --ancestors value", () => {
      const result = run(["--auto", "--ancestors", ""]);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("--auto", () => {
    // 呼び出し元のプロセスとして、lsofの出力に現れるべきPID。
    const CALLER_PID = "4242";

    // 呼び出し元のcwdを含む、正常なlsofの出力を返す偽のlsofにする。`extra`は追加の行。
    function writeCallerLsof(extra = ""): void {
      writeLsof(`p${CALLER_PID}\ncbash\nn${root}${extra ? `\n${extra}` : ""}`);
    }

    // 非同期に起動するテスト用の環境変数。`run`と同じ偽のコマンドを使わせる。
    function autoEnv(): Record<string, string> {
      return {
        ...cleanEnv(),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        WORKTREE_PRUNE_LSOF: join(fakeBin, "lsof"),
      };
    }

    function runAuto(
      options: { ancestors?: string | null; env?: Record<string, string> } = {},
    ): Run {
      const ancestors =
        options.ancestors === undefined ? CALLER_PID : options.ancestors;
      const args =
        ancestors === null ? ["--auto"] : ["--auto", "--ancestors", ancestors];
      return run(args, mainDir, options.env);
    }

    const stateDir = () => join(mainDir, ".git", "worktree-prune");
    const stateFile = (name: string) => join(stateDir(), name);

    // 状態のディレクトリを作り、`name`に`content`を書く。
    function seedState(name: string, content: string): void {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      writeFileSync(stateFile(name), content);
    }

    // 状態のディレクトリの`lock/`を作り、更新時刻を`secondsAgo`秒前にする(負なら未来)。
    function seedLock(secondsAgo: number): void {
      mkdirSync(stateFile("lock"), { recursive: true, mode: 0o700 });
      const when = new Date(Date.now() - secondsAgo * 1000);
      utimesSync(stateFile("lock"), when, when);
    }

    const nowSeconds = () => Math.floor(Date.now() / 1000);

    // lsofが呼ばれた時点の副作用`hook`(シェルの行)を持つ偽のlsofにする。
    function writeLsofWithHook(hook: string): void {
      writeLsof(`p${CALLER_PID}\ncbash\nn${root}`);
      const lsof = join(fakeBin, "lsof");
      const body = readFileSync(lsof, "utf8").replace(
        "#!/usr/bin/env bash\n",
        `#!/usr/bin/env bash\n${hook}\n`,
      );
      writeFileSync(lsof, body);
    }

    beforeEach(() => {
      writeCallerLsof();
    });

    test("--auto removes a merged idle worktree", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto();

      expect(existsSync(path)).toBe(false);
    });

    test("--auto removes the branch of a merged idle worktree", () => {
      addMergedWorktree("docs-old", "docs/old");

      runAuto();

      expect(branchExists("docs/old")).toBe(false);
    });

    test("--auto keeps recent", () => {
      const path = addMergedWorktree("docs-busy", "docs/busy");
      const now = new Date();
      utimesSync(join(path, "README.md"), now, now);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto keeps in use", () => {
      const path = addMergedWorktree("docs-busy", "docs/busy");
      writeCallerLsof(`p1234\nn${path}/console`);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto keeps dirty", () => {
      const path = addMergedWorktree("docs-dirty", "docs/dirty");
      writeFileSync(join(path, "scratch.txt"), "x\n");
      ageFiles(path, 180);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto keeps unmerged", () => {
      const path = addWorktree("docs-wip", "docs/wip");
      commitIn(path);
      ageFiles(path, 180);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing without ancestors", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto({ ancestors: null });

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing with an empty ancestors value", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto({ ancestors: "" });

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing with a malformed ancestors value", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto({ ancestors: "4242,abc" });

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing with an ancestors value that has an empty item", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto({ ancestors: "4242,,1" });

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing when lsof does not show the callers", () => {
      const path = addMergedWorktree("docs-old", "docs/old");
      writeLsof(`p9999\ncbash\nn${root}`);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing when only one of the ancestors would be a prefix", () => {
      const path = addMergedWorktree("docs-old", "docs/old");
      writeLsof(`p42420\ncbash\nn${root}`);

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes a worktree when any one ancestor shows up", () => {
      const path = addMergedWorktree("docs-old", "docs/old");

      runAuto({ ancestors: "7,4242,9" });

      expect(existsSync(path)).toBe(false);
    });

    test("--auto removes nothing without lsof", () => {
      const path = addMergedWorktree("docs-old", "docs/old");
      rmSync(join(fakeBin, "lsof"));

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    test("--auto removes nothing when lsof prints nothing", () => {
      const path = addMergedWorktree("docs-old", "docs/old");
      writeLsof("");

      runAuto();

      expect(existsSync(path)).toBe(true);
    });

    describe("lock", () => {
      test("--auto skips a lock younger than the limit", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedLock(60);

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto does not count a young lock as a failure", () => {
        addMergedWorktree("docs-old", "docs/old");
        seedLock(60);

        runAuto();

        expect(existsSync(stateFile("failures"))).toBe(false);
      });

      test("--auto leaves a young lock in place", () => {
        addMergedWorktree("docs-old", "docs/old");
        seedLock(60);

        runAuto();

        expect(existsSync(stateFile("lock"))).toBe(true);
      });

      test("--auto takes over a lock older than the limit", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedLock(11 * 60);

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto takes over a lock dated in the future", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedLock(-3600);

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto removes its own lock at the end", () => {
        addMergedWorktree("docs-old", "docs/old");

        runAuto();

        expect(existsSync(stateFile("lock"))).toBe(false);
      });

      test("--auto removes its own lock after a failure", () => {
        runAuto({ ancestors: null });

        expect(existsSync(stateFile("lock"))).toBe(false);
      });

      test("--auto leaves a lock owned by another run", () => {
        addMergedWorktree("docs-old", "docs/old");
        writeLsofWithHook(`echo other-run > "${stateFile("lock")}/owner"`);

        runAuto();

        expect(
          readFileSync(join(stateFile("lock"), "owner"), "utf8").trim(),
        ).toBe("other-run");
      });
    });

    describe("failures", () => {
      test("--auto increments failures before working", () => {
        seedState("failures", "2\n");
        const probe = join(root, "probe");
        writeLsofWithHook(`cat "${stateFile("failures")}" > "${probe}"`);

        runAuto();

        expect(readFileSync(probe, "utf8").trim()).toBe("3");
      });

      test("--auto resets failures on success", () => {
        seedState("failures", "5\n");

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("0");
      });

      test("--auto counts an anomaly as a failure", () => {
        runAuto({ ancestors: null });

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto adds to the count of earlier failures", () => {
        seedState("failures", "4\n");

        runAuto({ ancestors: null });

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("5");
      });

      test("--auto treats a malformed failures value as 0", () => {
        seedState("failures", "many\n");

        runAuto({ ancestors: null });

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto leaves the incremented failures when killed", async () => {
        addMergedWorktree("docs-old", "docs/old");
        const started = join(root, "started");
        writeLsofWithHook(`: > "${started}"; sleep 5`);

        const proc = Bun.spawn(
          [BASH, SCRIPT, "--auto", "--ancestors", CALLER_PID],
          {
            cwd: mainDir,
            env: autoEnv(),
          },
        );
        for (let i = 0; i < 100 && !existsSync(started); i++) {
          await Bun.sleep(50);
        }
        proc.kill("SIGKILL");
        await proc.exited;

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });
    });

    describe("gh", () => {
      // gh pr listが必要になる、squashマージ済み(に見える)worktreeを作る。
      function addSquashWorktree(
        name: string,
        branch: string,
      ): { path: string; tip: string } {
        const path = addWorktree(name, branch);
        const tip = commitIn(path);
        return { path, tip };
      }

      const logText = () => readFileSync(stateFile("log"), "utf8");

      test("--auto removes a squash-merged worktree when gh answers", () => {
        const { path, tip } = addSquashWorktree("feat-sq", "feat/sq");
        writeGh(`echo ${tip}`);

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto keeps a worktree when gh does not answer", () => {
        const { path, tip } = addSquashWorktree("feat-sq", "feat/sq");
        writeGh(`sleep 30\necho ${tip}`);

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "1" } });

        expect(existsSync(path)).toBe(true);
      });

      test("--auto stops asking gh after one timeout", () => {
        addSquashWorktree("feat-sq1", "feat/sq1");
        addSquashWorktree("feat-sq2", "feat/sq2");
        const calls = join(root, "gh-calls");
        writeGh(`echo called >> "${calls}"\nsleep 30`);

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "1" } });

        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
      });

      test("--auto marks every candidate as gh unavailable after one timeout", () => {
        addSquashWorktree("feat-sq1", "feat/sq1");
        addSquashWorktree("feat-sq2", "feat/sq2");
        writeGh("sleep 30");

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "1" } });

        expect(logText().match(/gh unavailable/g)).toHaveLength(2);
      });

      test("--auto kills the whole gh process group on a timeout", async () => {
        addSquashWorktree("feat-sq", "feat/sq");
        const childPid = join(root, "gh-child-pid");
        writeGh(`sleep 47 &\necho $! > "${childPid}"\nwait`);

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "1" } });
        await Bun.sleep(300);

        const alive = Bun.spawnSync([
          "kill",
          "-0",
          readFileSync(childPid, "utf8").trim(),
        ]);
        expect(alive.exitCode).not.toBe(0);
      });

      test("--auto counts a gh timeout as a failure", () => {
        addSquashWorktree("feat-sq", "feat/sq");
        writeGh("sleep 30");

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "1" } });

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto counts a gh failure as a failure", () => {
        addSquashWorktree("feat-sq", "feat/sq");
        writeGh("exit 1");

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto does not count an unmerged answer from gh as a failure", () => {
        addSquashWorktree("feat-sq", "feat/sq");
        writeGh("exit 0");

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("0");
      });

      test("--auto does not update the stamp when gh is unavailable", () => {
        addSquashWorktree("feat-sq", "feat/sq");
        writeGh("exit 1");

        runAuto();

        expect(existsSync(stateFile("stamp"))).toBe(false);
      });

      test("--auto exits 0 on failure", () => {
        addSquashWorktree("feat-sq", "feat/sq");
        writeGh("exit 1");

        const result = runAuto();

        expect(result.exitCode).toBe(0);
      });

      test("--auto ignores a gh time limit above 30", () => {
        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "100" } });

        expect(logText()).toContain("gh time limit 30s");
      });

      test("--auto ignores a gh time limit that is not a number", () => {
        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "soon" } });

        expect(logText()).toContain("gh time limit 30s");
      });

      test("--auto accepts a gh time limit of 30 or less", () => {
        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "7" } });

        expect(logText()).toContain("gh time limit 7s");
      });
    });

    describe("stamp", () => {
      test("--auto skips within 30 minutes", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", `${nowSeconds() - 600}\n`);

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto does not count a skip within 30 minutes as a failure", () => {
        addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", `${nowSeconds() - 600}\n`);

        runAuto();

        expect(existsSync(stateFile("failures"))).toBe(false);
      });

      test("--auto runs after 30 minutes", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", `${nowSeconds() - 31 * 60}\n`);

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto treats a future stamp as stale", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", `${nowSeconds() + 3600}\n`);

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto treats a malformed stamp as stale", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", "yesterday\n");

        runAuto();

        expect(existsSync(path)).toBe(false);
      });

      test("--auto updates the stamp on success", () => {
        const old = nowSeconds() - 31 * 60;
        seedState("stamp", `${old}\n`);

        runAuto();

        expect(
          Number(readFileSync(stateFile("stamp"), "utf8").trim()),
        ).toBeGreaterThan(old);
      });

      test("--auto does not touch the stamp on failure", () => {
        const old = String(nowSeconds() - 31 * 60);
        seedState("stamp", `${old}\n`);

        runAuto({ ancestors: null });

        expect(readFileSync(stateFile("stamp"), "utf8").trim()).toBe(old);
      });
    });

    test("--auto exits 0 when lsof does not show the callers", () => {
      writeLsof(`p9999\ncbash\nn${root}`);

      const result = runAuto();

      expect(result.exitCode).toBe(0);
    });

    describe("state files", () => {
      // 状態のディレクトリを作り、その中の`name`を`target`へのシンボリックリンクにする。
      function linkStateFile(name: string, target: string): void {
        mkdirSync(stateDir(), { mode: 0o700 });
        symlinkSync(target, stateFile(name));
      }

      test("--auto prints nothing to stdout", () => {
        addMergedWorktree("docs-old", "docs/old");

        const result = runAuto();

        expect(result.stdout).toBe("");
      });

      test("--auto writes the log", () => {
        addMergedWorktree("docs-old", "docs/old");

        runAuto();

        expect(readFileSync(stateFile("log"), "utf8")).toContain("removed: ");
      });

      test("--auto writes the reason a worktree was kept to the log", () => {
        addMergedWorktree("docs-old", "docs/old");
        addWorktree("docs-wip", "docs/wip");

        runAuto();

        expect(readFileSync(stateFile("log"), "utf8")).toContain(
          "(docs/wip): unused",
        );
      });

      test("--auto writes a failure to the log", () => {
        runAuto({ ancestors: null });

        expect(readFileSync(stateFile("log"), "utf8")).toContain("failed: ");
      });

      test("--auto creates the state directory readable only by the owner", () => {
        runAuto();

        expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
      });

      test("--auto trims a large log", () => {
        mkdirSync(stateDir(), { mode: 0o700 });
        writeFileSync(stateFile("log"), "old line\n".repeat(30_000));

        runAuto();

        expect(statSync(stateFile("log")).size).toBeLessThan(102_400);
      });

      test("--auto keeps the end of a large log", () => {
        mkdirSync(stateDir(), { mode: 0o700 });
        writeFileSync(
          stateFile("log"),
          `${"old line\n".repeat(30_000)}last old line\n`,
        );

        runAuto();

        expect(readFileSync(stateFile("log"), "utf8")).toContain(
          "last old line\n",
        );
      });

      test("--auto writes the stamp as epoch seconds on success", () => {
        const before = Math.floor(Date.now() / 1000);

        runAuto();

        const stamp = Number(readFileSync(stateFile("stamp"), "utf8").trim());
        expect(stamp).toBeGreaterThanOrEqual(before);
      });

      test("--auto writes 0 to failures on success", () => {
        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("0");
      });

      test("--auto does nothing when the state directory is a symlink", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        const elsewhere = join(root, "elsewhere-state");
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, stateDir());

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto writes nothing into the target of a symlinked state directory", () => {
        addMergedWorktree("docs-old", "docs/old");
        const elsewhere = join(root, "elsewhere-state");
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, stateDir());

        runAuto();

        expect(readdirSync(elsewhere)).toEqual([]);
      });

      test("--auto does nothing when lock is a symlink", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        const elsewhere = join(root, "elsewhere-lock");
        mkdirSync(elsewhere);
        linkStateFile("lock", elsewhere);

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto does nothing when log is a symlink", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        linkStateFile("log", join(root, "victim"));

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto does nothing when stamp is a symlink", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        linkStateFile("stamp", join(root, "victim"));

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto does nothing when failures is a symlink", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        linkStateFile("failures", join(root, "victim"));

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto never writes through a symlink target", () => {
        addMergedWorktree("docs-old", "docs/old");
        const victim = join(root, "victim");
        writeFileSync(victim, "untouched\n");
        linkStateFile("log", victim);

        runAuto();

        expect(readFileSync(victim, "utf8")).toBe("untouched\n");
      });

      test("--auto never writes through a symlink to a directory", () => {
        addMergedWorktree("docs-old", "docs/old");
        const elsewhere = join(root, "elsewhere-dir");
        mkdirSync(elsewhere);
        linkStateFile("stamp", elsewhere);

        runAuto();

        expect(readdirSync(elsewhere)).toEqual([]);
      });
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
