import { beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ageFiles,
  BASH,
  cleanEnv,
  git,
  requireBin,
  SCRIPT,
  setupWorktreePruneEnv,
} from "./worktree-prune-support.ts";

describe("worktree-prune.sh", () => {
  const env = setupWorktreePruneEnv();
  const {
    writeGh,
    run,
    worktreePath,
    branchExists,
    addWorktree,
    writeLsof,
    ageReflog,
    commitIn,
    advanceOrigin,
    addMergedWorktree,
  } = env;
  let root: string;
  let mainDir: string;
  let fakeBin: string;

  beforeEach(() => {
    root = env.root;
    mainDir = env.mainDir;
    fakeBin = env.fakeBin;
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

  describe("yomiyasu check records", () => {
    // yomiyasu_checkが置く`.gitignore`と同じ内容。置いたものは中身を問わず無視される。
    const RECORD_GITIGNORE = "# yomiyasu records\n*\n";

    function writeFileIn(path: string, file: string, content: string): void {
      mkdirSync(join(path, file, ".."), { recursive: true });
      writeFileSync(join(path, file), content);
    }

    function writeRecordsIn(path: string, dir: string): void {
      writeFileIn(path, join(dir, ".gitignore"), RECORD_GITIGNORE);
      writeFileIn(path, join(dir, "state.json"), "{}\n");
    }

    // メインの`.git/info/exclude`は、すべてのworktreeに効く。
    function excludeYomiyasu(): void {
      mkdirSync(join(mainDir, ".git", "info"), { recursive: true });
      appendFileSync(join(mainDir, ".git", "info", "exclude"), ".yomiyasu\n");
    }

    test("removes a worktree that holds only yomiyasu check records", () => {
      const path = addMergedWorktree("docs-yrec", "docs/yrec");
      writeFileIn(path, ".yomiyasu/.gitignore", RECORD_GITIGNORE);
      writeFileIn(path, ".yomiyasu/state.json", "{}\n");
      writeFileIn(path, ".yomiyasu/runs/r1/attempt-1.json", "{}\n");
      writeFileIn(path, ".yomiyasu/inputs/abc.bin", "b\n");
      writeFileIn(path, ".yomiyasu/exports/r1/attempt-1-abc.md", "m\n");
      ageFiles(path, 180);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    test("keeps a nested repository under .yomiyasu as ignored files", () => {
      const path = addMergedWorktree("docs-ynest", "docs/ynest");
      writeFileIn(path, ".yomiyasu/.gitignore", RECORD_GITIGNORE);
      writeFileIn(path, ".yomiyasu/upstream/a.txt", "a\n");
      git(join(path, ".yomiyasu", "upstream"), ["init", "--quiet"]);
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/ynest): ignored files`,
      );
    });

    test("keeps a nested repository named node_modules under .yomiyasu as ignored files", () => {
      const path = addMergedWorktree("docs-ynm", "docs/ynm");
      writeFileIn(path, ".yomiyasu/.gitignore", RECORD_GITIGNORE);
      writeFileIn(path, ".yomiyasu/node_modules/a.txt", "a\n");
      git(join(path, ".yomiyasu", "node_modules"), ["init", "--quiet"]);
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/ynm): ignored files`,
      );
    });

    test("keeps a .yomiyasu.local.toml file as ignored files", () => {
      const path = addMergedWorktree("docs-ylocal", "docs/ylocal");
      writeFileIn(path, ".yomiyasu.local.toml", "x = 1\n");
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/ylocal): ignored files`,
      );
    });

    test("keeps an ignored .yomiyasu directory below the top level", () => {
      const path = addMergedWorktree("docs-ydeep", "docs/ydeep");
      writeRecordsIn(path, "console/.yomiyasu");
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/ydeep): ignored files`,
      );
    });

    test("keeps a .yomiyasu symlink as dirty", () => {
      const path = addMergedWorktree("docs-ylink", "docs/ylink");
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(path, ".yomiyasu"));

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/ylink): dirty`);
    });

    test("keeps an excluded .yomiyasu symlink as ignored files", () => {
      excludeYomiyasu();
      const path = addMergedWorktree("docs-yxlink", "docs/yxlink");
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(path, ".yomiyasu"));

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/yxlink): ignored files`,
      );
    });

    test("keeps a .yomiyasu directory without its .gitignore as dirty", () => {
      const path = addMergedWorktree("docs-ybare", "docs/ybare");
      writeFileIn(path, ".yomiyasu/state.json", "{}\n");

      const result = run();

      expect(result.stdout).toContain(`kept: ${path} (docs/ybare): dirty`);
    });

    test("keeps an excluded repository at .yomiyasu as ignored files", () => {
      excludeYomiyasu();
      const path = addMergedWorktree("docs-yrepo", "docs/yrepo");
      writeFileIn(path, ".yomiyasu/a.txt", "a\n");
      git(join(path, ".yomiyasu"), ["init", "--quiet"]);
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/yrepo): ignored files`,
      );
    });

    test("keeps a quoted path under .yomiyasu as ignored files", () => {
      const path = addMergedWorktree("docs-yquote", "docs/yquote");
      writeFileIn(path, ".yomiyasu/.gitignore", RECORD_GITIGNORE);
      writeFileIn(path, ".yomiyasu/あ.md", "m\n");
      ageFiles(path, 180);

      const result = run();

      expect(result.stdout).toContain(
        `kept: ${path} (docs/yquote): ignored files`,
      );
    });

    test("removes an excluded .yomiyasu directory without its .gitignore", () => {
      excludeYomiyasu();
      const path = addMergedWorktree("docs-yxdir", "docs/yxdir");
      writeFileIn(path, ".yomiyasu/state.json", "{}\n");
      ageFiles(path, 180);

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
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
});
