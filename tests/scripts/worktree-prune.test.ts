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
