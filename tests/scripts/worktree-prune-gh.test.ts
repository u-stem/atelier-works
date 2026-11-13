import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireBin, setupWorktreePruneEnv } from "./worktree-prune-support.ts";

describe("worktree-prune.sh", () => {
  const env = setupWorktreePruneEnv();
  const { writeGh, writeCallerLsof, runAuto, addSquashWorktree, logText } = env;
  let root: string;
  let fakeBin: string;

  beforeEach(() => {
    root = env.root;
    fakeBin = env.fakeBin;
  });

  describe("--auto", () => {
    beforeEach(() => {
      writeCallerLsof();
    });

    describe("gh", () => {
      // 1件ごとは上限より短く返るが、合計が上限を超える候補の列を作る。
      function addSlowCandidates(): string {
        const calls = join(root, "gh-calls");
        for (const n of [1, 2, 3, 4, 5, 6]) {
          addSquashWorktree(`feat-sq${n}`, `feat/sq${n}`);
        }
        writeGh(`echo called >> "${calls}"\nsleep 1`);
        return calls;
      }

      // `git status`の前に`seconds`秒眠る偽のgit。候補の間の処理が長い状況を作る。
      function writeSlowStatusGit(seconds: number): void {
        writeFileSync(
          join(fakeBin, "git"),
          `#!/usr/bin/env bash\nif [ "$3" = "status" ]; then sleep ${seconds}; fi\nexec "${requireBin("git")}" "$@"\n`,
        );
        chmodSync(join(fakeBin, "git"), 0o755);
      }

      test("--auto does not count the time between candidates against the gh limit", () => {
        const calls = join(root, "gh-calls");
        for (const n of [1, 2, 3]) {
          addSquashWorktree(`feat-sq${n}`, `feat/sq${n}`);
        }
        writeGh(`echo called >> "${calls}"\nsleep 1`);
        writeSlowStatusGit(5);

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "10" } });

        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
      }, 60_000);

      test("--auto stops asking gh once the total time reaches the limit", () => {
        const calls = addSlowCandidates();

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "3" } });

        expect(
          readFileSync(calls, "utf8").trim().split("\n").length,
        ).toBeLessThan(6);
      }, 30_000);

      test("--auto leaves the rest as gh unavailable once the total time reaches the limit", () => {
        addSlowCandidates();

        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "3" } });

        expect(logText()).toContain("gh unavailable");
      }, 30_000);

      test("--auto kills the whole gh process group on a timeout", async () => {
        addSquashWorktree("feat-sq", "feat/sq");
        const childPid = join(root, "gh-child-pid");
        writeGh(`sleep 47 &\necho $! > "${childPid}"\nwait`);

        // 上限は最初のgitの処理から数える。負荷でghを呼ぶ前に上限へ達しないよう、余裕を持たせる。
        runAuto({ env: { WORKTREE_PRUNE_GH_TIMEOUT: "5" } });

        const pid = readFileSync(childPid, "utf8").trim();
        // 実時間が要る。子の終了は、シグナルを送った後の非同期の処理なので、実プロセスが終わるまで条件で待つ。
        let alive = true;
        for (let waited = 0; alive && waited < 5000; waited += 100) {
          alive = Bun.spawnSync(["kill", "-0", pid]).exitCode === 0;
          if (alive) await Bun.sleep(100);
        }
        expect(alive).toBe(false);
      }, 30_000);
    });
  });
});
