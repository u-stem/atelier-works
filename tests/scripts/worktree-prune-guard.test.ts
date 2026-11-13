import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ageFiles,
  BASH,
  git,
  requireBin,
  SCRIPT,
  setupWorktreePruneEnv,
} from "./worktree-prune-support.ts";

describe("worktree-prune.sh", () => {
  const env = setupWorktreePruneEnv();
  const {
    run,
    worktreePath,
    branchExists,
    addWorktree,
    writeLsof,
    commitIn,
    advanceOrigin,
    addMergedWorktree,
    writeLsofChanging,
    CALLER_PID,
    writeCallerLsof,
    autoEnv,
    runAuto,
    stateFile,
  } = env;
  let root: string;
  let mainDir: string;
  let fakeBin: string;

  beforeEach(() => {
    root = env.root;
    mainDir = env.mainDir;
    fakeBin = env.fakeBin;
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

  describe("re-checking just before the removal", () => {
    let path: string;

    beforeEach(() => {
      path = addMergedWorktree("docs-old", "docs/old");
    });

    // 2回目の`git status`が始まる前に`hook`(シェルの行)を実行する偽のgit。
    // 最初の検査の後、削除の直前の検査が始まる前に、worktreeが変わる状況を作る。
    function writeStatusHook(hook: string): void {
      const counter = join(root, "hook-status-count");
      writeFileSync(
        join(fakeBin, "git"),
        [
          "#!/usr/bin/env bash",
          'if [ "$3" = "status" ]; then',
          `  n=$(cat "${counter}" 2>/dev/null || echo 0)`,
          "  n=$((n + 1))",
          `  echo "$n" > "${counter}"`,
          `  if [ "$n" -eq 2 ]; then ${hook}; fi`,
          "fi",
          `exec "${requireBin("git")}" "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(join(fakeBin, "git"), 0o755);
    }

    test("keeps a worktree that became dirty after the first check", () => {
      writeStatusHook(`echo x > "${path}/new.txt"`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps a worktree that became recent after the first check", () => {
      writeStatusHook(`touch "${path}/README.md"`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps a worktree that came into use after the first check", () => {
      writeLsofChanging("p1\nn/", `p1\nn${path}`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps a worktree whose branch moved after the first check", () => {
      writeStatusHook(
        `git -C "${path}" commit -q --allow-empty --no-gpg-sign -m moved`,
      );

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("keeps the branch of a worktree that became dirty after the first check", () => {
      writeStatusHook(`echo x > "${path}/new.txt"`);

      run(["--apply"]);

      expect(branchExists("docs/old")).toBe(true);
    });

    test("reports dirty for a worktree that became dirty after the first check", () => {
      writeStatusHook(`echo x > "${path}/new.txt"`);

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/old): dirty`);
    });

    test("reports recent for a worktree that became recent after the first check", () => {
      writeStatusHook(`touch "${path}/README.md"`);

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/old): recent`);
    });

    test("reports branch moved for a worktree whose branch moved after the first check", () => {
      writeStatusHook(
        `git -C "${path}" commit -q --allow-empty --no-gpg-sign -m moved`,
      );

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/old): branch moved`);
    });

    test("reports the reason for keeping a worktree that came into use", () => {
      writeLsofChanging("p1\nn/", `p1\nn${path}`);

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/old): in use`);
    });

    test("removes the worktree when nothing changed between the checks", () => {
      writeLsofChanging("p1\nn/", "p1\nn/");

      run(["--apply"]);

      expect(existsSync(path)).toBe(false);
    });

    // 2回目の`git status`が始まった後にだけ、`afterOutput`を返す偽のlsofと、
    // 2回目の`git status`の印を付ける偽のgit。削除の直前の検査で、lsofが
    // `git status`より後に呼ばれるかを確かめる。
    function writeLateProcess(beforeOutput: string, afterOutput: string): void {
      const counter = join(root, "status-count");
      const marker = join(root, "second-status");
      writeFileSync(
        join(fakeBin, "git"),
        [
          "#!/usr/bin/env bash",
          'if [ "$3" = "status" ]; then',
          `  n=$(cat "${counter}" 2>/dev/null || echo 0)`,
          "  n=$((n + 1))",
          `  echo "$n" > "${counter}"`,
          `  if [ "$n" -ge 2 ]; then : > "${marker}"; fi`,
          "fi",
          `exec "${requireBin("git")}" "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(join(fakeBin, "git"), 0o755);
      writeFileSync(
        join(fakeBin, "lsof"),
        [
          "#!/usr/bin/env bash",
          `if [ -e "${marker}" ]; then`,
          `  cat <<'EOF'\n${afterOutput}\nEOF`,
          "else",
          `  cat <<'EOF'\n${beforeOutput}\nEOF`,
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(join(fakeBin, "lsof"), 0o755);
    }

    test("keeps a worktree whose process appeared while the re-check ran", () => {
      writeLateProcess("p1\nn/", `p1\nn${path}`);

      run(["--apply"]);

      expect(existsSync(path)).toBe(true);
    });

    test("reports in use for a process that appeared while the re-check ran", () => {
      writeLateProcess("p1\nn/", `p1\nn${path}`);

      const result = run(["--apply"]);

      expect(result.stdout).toContain(`kept: ${path} (docs/old): in use`);
    });

    test("does not call lsof again in the dry run", () => {
      writeLsofChanging("p1\nn/", `p1\nn${path}`);

      const result = run();

      expect(result.stdout).toContain(`would remove: ${path} (docs/old)`);
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

  describe("--auto", () => {
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

    test("--auto keeps the worktree it runs in as current directory", () => {
      const path = addMergedWorktree("fix-current", "fix/current");

      run(["--auto", "--ancestors", CALLER_PID], path);

      expect(existsSync(path)).toBe(true);
    });

    test("--auto logs current directory as the reason for keeping the worktree it runs in", () => {
      const path = addMergedWorktree("fix-current", "fix/current");

      run(["--auto", "--ancestors", CALLER_PID], path);

      expect(readFileSync(stateFile("log"), "utf8")).toContain(
        `kept: ${path} (fix/current): current directory`,
      );
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

    test("--auto exits 0 when lsof does not show the callers", () => {
      writeLsof(`p9999\ncbash\nn${root}`);

      const result = runAuto();

      expect(result.exitCode).toBe(0);
    });

    describe("removal", () => {
      const callers = () => `p${CALLER_PID}\ncbash\nn${root}`;

      // `worktree remove`だけを`body`(シェルの行)に差し替える、偽のgit。他は本物のgitに渡す。
      function writeGitWrapper(body: string): void {
        writeFileSync(
          join(fakeBin, "git"),
          `#!/usr/bin/env bash\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then\n${body}\nfi\nexec "${requireBin("git")}" "$@"\n`,
        );
        chmodSync(join(fakeBin, "git"), 0o755);
      }

      test("--auto keeps a worktree that came into use after the first check", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        writeLsofChanging(callers(), `${callers()}\nn${path}`);

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto removes nothing when the second lsof does not show the callers", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        writeLsofChanging(callers(), `p9999\ncbash\nn${root}`);

        runAuto();

        expect(existsSync(path)).toBe(true);
      });

      test("--auto counts a second lsof that does not show the callers as a failure", () => {
        addMergedWorktree("docs-old", "docs/old");
        writeLsofChanging(callers(), `p9999\ncbash\nn${root}`);

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto counts a failed removal as a failure", () => {
        addMergedWorktree("docs-old", "docs/old");
        writeGitWrapper("  exit 1");

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto does not update the stamp after a failed removal", () => {
        addMergedWorktree("docs-old", "docs/old");
        writeGitWrapper("  exit 1");

        runAuto();

        expect(existsSync(stateFile("stamp"))).toBe(false);
      });

      test("--auto ignores TERM while removing", async () => {
        addMergedWorktree("docs-old", "docs/old");
        const started = join(root, "remove-started");
        writeGitWrapper(`  : > "${started}"\n  sleep 2`);

        const proc = Bun.spawn(
          [BASH, SCRIPT, "--auto", "--ancestors", CALLER_PID],
          { cwd: mainDir, env: autoEnv() },
        );
        // 実時間が要る。別プロセスのシェルが印のファイルを作るのを、条件で待つ。条件が成り立てばすぐ抜ける。
        for (let i = 0; i < 100 && !existsSync(started); i++) {
          await Bun.sleep(50);
        }
        proc.kill("SIGTERM");
        await proc.exited;

        expect(branchExists("docs/old")).toBe(false);
      });
    });
  });
});
