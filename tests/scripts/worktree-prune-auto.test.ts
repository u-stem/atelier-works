import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BASH,
  SCRIPT,
  setupWorktreePruneEnv,
} from "./worktree-prune-support.ts";

describe("worktree-prune.sh", () => {
  const env = setupWorktreePruneEnv();
  const {
    writeGh,
    addWorktree,
    writeLsof,
    addMergedWorktree,
    CALLER_PID,
    writeCallerLsof,
    autoEnv,
    runAuto,
    stateDir,
    stateFile,
    seedState,
    seedLock,
    nowSeconds,
    writeLsofWithHook,
    addSquashWorktree,
    logText,
  } = env;
  let root: string;
  let mainDir: string;
  let fakeBin: string;

  beforeEach(() => {
    root = env.root;
    mainDir = env.mainDir;
    fakeBin = env.fakeBin;
  });

  describe("--auto", () => {
    beforeEach(() => {
      writeCallerLsof();
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

      test("--auto counts lsof not showing the callers as a failure", () => {
        writeLsof(`p9999\ncbash\nn${root}`);

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto counts a missing lsof as a failure", () => {
        rmSync(join(fakeBin, "lsof"));

        runAuto();

        expect(readFileSync(stateFile("failures"), "utf8").trim()).toBe("1");
      });

      test("--auto counts an empty lsof output as a failure", () => {
        writeLsof("");

        runAuto();

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

      test("--auto reads a stamp with leading zeros as a decimal number", () => {
        const path = addMergedWorktree("docs-old", "docs/old");
        seedState("stamp", `0${nowSeconds() - 600}\n`);

        runAuto();

        expect(existsSync(path)).toBe(true);
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

    describe("gh", () => {
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
  });
});
