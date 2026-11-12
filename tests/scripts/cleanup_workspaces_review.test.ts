// `cleanup_workspaces.ts`のレビュー用の作業ツリーの片付けのテスト。
// 起点は作業ツリーの一覧で、PR番号ごとに次を行う。
// 終端でない`pr_review`の作業項目があれば何も消さず、使用中の確認もしない。
// 無ければ、ディレクトリの更新が期限より古い作業ツリーだけを、shaを問わず消す。

import { describe, expect, test } from "bun:test";
import {
  type ReviewWorktreeRemovalDeps,
  type ReviewWorktreeSweepDeps,
  type ReviewWorktreeTarget,
  removeReviewWorktrees,
  removeStaleReviewWorktrees,
} from "../../f/factory/cleanup_workspaces.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";

const REPO_DIR = "/workspaces/acme/widgets/main";
const PARENT = "/workspaces/acme/widgets";
const CUTOFF = new Date("2026-11-05T00:00:00Z");
const OLD = CUTOFF.getTime() - 86_400_000;
const NEW = CUTOFF.getTime() + 86_400_000;

const OLD_A = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
const OLD_B = `${PARENT}/review-42-bbbbbbb-4e5f6a7b`;
/** 識別子の無い形(`review-<PR番号>-<sha7>`)。 */
const OLD_NO_RUN_ID = `${PARENT}/review-42-aaaaaaa`;
const NEW_A = `${PARENT}/review-42-ccccccc-9a8b7c6d`;
const OTHER_PR = `${PARENT}/review-43-aaaaaaa-0a1b2c3d`;

function target(
  path: string,
  lock?: { readonly reason: string | null },
): ReviewWorktreeTarget {
  return lock === undefined ? { path } : { path, lock };
}

type Setup = {
  /** `hasActiveReview`の戻り値。呼ぶたびに順に使い、足りなければ最後の値を使う。 */
  readonly active?: readonly boolean[];
  readonly activeFails?: readonly boolean[];
  /** 作業ツリーのディレクトリの更新の時刻。無いものは読めない。 */
  readonly mtimes?: Readonly<Record<string, number>>;
  readonly free?: (dir: string) => boolean;
  readonly ensureFreeFails?: (dir: string) => boolean;
  readonly removeFails?: (dir: string) => boolean;
};

function setup(options: Setup = {}) {
  const removed: { dir: string; forceLocked: boolean }[] = [];
  const warnings: { message: string; fields: LogFields }[] = [];
  const counts = { active: 0, free: 0, mtime: 0 };
  const deps: ReviewWorktreeRemovalDeps = {
    hasActiveReview: async () => {
      const index = counts.active;
      counts.active += 1;
      if (options.activeFails?.[index] === true) {
        throw new Error("database is down");
      }
      const active = options.active ?? [false];
      return active[Math.min(index, active.length - 1)] ?? false;
    },
    modifiedAtMs: async (dir) => {
      counts.mtime += 1;
      const mtime = options.mtimes?.[dir];
      if (mtime === undefined) throw new Error(`cannot stat ${dir}`);
      return mtime;
    },
    ensureFree: async (dir) => {
      counts.free += 1;
      if (options.ensureFreeFails?.(dir) === true) {
        throw new Error(`cannot check ${dir}`);
      }
      return options.free?.(dir) ?? true;
    },
    removeWorktree: async (dir, removal) => {
      if (options.removeFails?.(dir) === true) {
        throw new Error(`cannot remove ${dir}`);
      }
      removed.push({ dir, forceLocked: removal.forceLocked });
    },
    warn: (message, fields) => warnings.push({ message, fields }),
  };
  const run = (targets: readonly ReviewWorktreeTarget[]) =>
    removeReviewWorktrees(
      { repoDir: REPO_DIR, prNumber: 42, targets, cutoff: CUTOFF },
      deps,
    );
  return {
    run,
    deps,
    removed,
    removedDirs: () => removed.map((item) => item.dir),
    warnings,
    counts,
  };
}

describe("removeReviewWorktrees", () => {
  test("removes a worktree older than the cutoff when no pr_review is running", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A)]);
    expect(s.removedDirs()).toEqual([OLD_A]);
  });

  test("returns the number of removed worktrees", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
    expect(await s.run([target(OLD_A), target(OLD_B)])).toBe(2);
  });

  test("keeps a worktree newer than the cutoff", async () => {
    const s = setup({ mtimes: { [NEW_A]: NEW } });
    await s.run([target(NEW_A)]);
    expect(s.removedDirs()).toEqual([]);
  });

  test("keeps a worktree modified exactly at the cutoff", async () => {
    const s = setup({ mtimes: { [OLD_A]: CUTOFF.getTime() } });
    await s.run([target(OLD_A)]);
    expect(s.removedDirs()).toEqual([]);
  });

  test("removes only the old worktrees of a pr that also has new ones", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [NEW_A]: NEW, [OLD_NO_RUN_ID]: OLD },
    });
    await s.run([target(OLD_A), target(NEW_A), target(OLD_NO_RUN_ID)]);
    expect(s.removedDirs()).toEqual([OLD_A, OLD_NO_RUN_ID]);
  });

  test("removes nothing while a pr_review of the pr is running", async () => {
    const s = setup({ active: [true], mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A)]);
    expect(s.removedDirs()).toEqual([]);
  });

  test("does not read the modification time or check the use while a pr_review is running", async () => {
    const s = setup({ active: [true], mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.counts).toEqual({ active: 1, free: 0, mtime: 0 });
  });

  test("checks for a running pr_review before and right before the removal", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.counts.active).toBe(2);
  });

  test("checks for a running pr_review twice however many worktrees there are", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD, [OLD_NO_RUN_ID]: OLD },
    });
    await s.run([target(OLD_A), target(OLD_B), target(OLD_NO_RUN_ID)]);
    expect(s.counts.active).toBe(2);
  });

  test("removes nothing when the check right before the removal finds a running pr_review", async () => {
    const s = setup({
      active: [false, true],
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([]);
  });

  test("does not check the use of a worktree newer than the cutoff", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD, [NEW_A]: NEW } });
    await s.run([target(OLD_A), target(NEW_A)]);
    expect(s.counts.free).toBe(1);
  });

  test("keeps a worktree whose modification time cannot be read", async () => {
    const s = setup({ mtimes: { [OLD_B]: OLD } });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([OLD_B]);
  });

  test("warns with the path of a worktree whose modification time cannot be read", async () => {
    const s = setup({ mtimes: {} });
    await s.run([target(OLD_A)]);
    expect(s.warnings.map((warning) => warning.fields.worktree_dir)).toEqual([
      OLD_A,
    ]);
  });

  test("records one warning and removes nothing when the first check fails", async () => {
    const s = setup({
      activeFails: [true],
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.warnings.map((warning) => warning.message)).toEqual([
      "cleanup: failed to check active pr_review",
    ]);
  });

  test("records one warning and removes nothing when the check right before the removal fails", async () => {
    const s = setup({
      activeFails: [false, true],
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect([
      s.removedDirs(),
      s.warnings.map((warning) => warning.message),
    ]).toEqual([[], ["cleanup: failed to re-check active pr_review"]]);
  });

  test("names the cause when the check fails", async () => {
    const s = setup({ activeFails: [true], mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A)]);
    expect(s.warnings[0]?.fields.error).toBe("database is down");
  });

  test("continues with the next worktree after one fails to be removed", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      removeFails: (dir) => dir === OLD_A,
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([OLD_B]);
  });

  test("warns with the path of the worktree that failed to be removed", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      removeFails: (dir) => dir === OLD_A,
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.warnings.map((warning) => warning.fields.worktree_dir)).toEqual([
      OLD_A,
    ]);
  });

  test("continues with the next worktree when the first is in use", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      free: (dir) => dir !== OLD_A,
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([OLD_B]);
  });

  test("does not check for a running pr_review again when every worktree is in use", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD }, free: () => false });
    await s.run([target(OLD_A)]);
    expect(s.counts.active).toBe(1);
  });

  test("continues with the next worktree when checking the use of one throws", async () => {
    const s = setup({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      ensureFreeFails: (dir) => dir === OLD_A,
    });
    await s.run([target(OLD_A), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([OLD_B]);
  });

  test("removes a worktree locked as initializing with forceLocked", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A, { reason: "initializing" })]);
    expect(s.removed).toEqual([{ dir: OLD_A, forceLocked: true }]);
  });

  test("removes an unlocked worktree without forceLocked", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A)]);
    expect(s.removed).toEqual([{ dir: OLD_A, forceLocked: false }]);
  });

  test("keeps a worktree locked for another reason and warns", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A, { reason: "on a usb drive" })]);
    expect([s.removedDirs(), s.warnings.length]).toEqual([[], 1]);
  });

  test("keeps a worktree locked without a reason and continues with the next", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
    await s.run([target(OLD_A, { reason: null }), target(OLD_B)]);
    expect(s.removedDirs()).toEqual([OLD_B]);
  });

  test("does not check the use of a worktree locked for another reason", async () => {
    const s = setup({ mtimes: { [OLD_A]: OLD } });
    await s.run([target(OLD_A, { reason: "on a usb drive" })]);
    expect(s.counts.free).toBe(0);
  });
});

describe("removeStaleReviewWorktrees", () => {
  function entry(
    path: string,
    overrides: Partial<WorktreeEntry> = {},
  ): WorktreeEntry {
    return {
      path,
      headSha: null,
      branch: null,
      bare: false,
      detached: true,
      ...overrides,
    };
  }

  const MAIN_ENTRY = entry(REPO_DIR, { detached: false, branch: "main" });

  function sweep(
    worktrees: readonly WorktreeEntry[],
    perPr: (prNumber: number) => Setup,
  ) {
    const removed: string[] = [];
    const warnings: string[] = [];
    const seenPrs: number[] = [];
    const deps: ReviewWorktreeSweepDeps = {
      findMainRepoDirs: async () => [REPO_DIR],
      listWorktrees: async () => worktrees,
      removalDeps: (_repoDir, prNumber) => {
        seenPrs.push(prNumber);
        const inner = setup(perPr(prNumber));
        return {
          ...inner.deps,
          removeWorktree: async (dir, removal) => {
            await inner.deps.removeWorktree(dir, removal);
            removed.push(dir);
          },
        };
      },
      warn: (message) => warnings.push(message),
    };
    return {
      run: () => removeStaleReviewWorktrees(deps, CUTOFF),
      removed,
      warnings,
      seenPrs,
    };
  }

  test("removes the old worktrees of a pr whose work items keep finishing recently", async () => {
    const s = sweep([MAIN_ENTRY, entry(OLD_A), entry(NEW_A)], () => ({
      mtimes: { [OLD_A]: OLD, [NEW_A]: NEW },
    }));
    await s.run();
    expect(s.removed).toEqual([OLD_A]);
  });

  test("removes the old worktrees of a pr that has no work item row", async () => {
    const s = sweep([entry(OLD_A)], () => ({
      active: [false],
      mtimes: { [OLD_A]: OLD },
    }));
    await s.run();
    expect(s.removed).toEqual([OLD_A]);
  });

  test("removes nothing for a pr with a running pr_review", async () => {
    const s = sweep([entry(OLD_A)], () => ({
      active: [true],
      mtimes: { [OLD_A]: OLD },
    }));
    await s.run();
    expect(s.removed).toEqual([]);
  });

  test("handles each pr once with only its own worktrees", async () => {
    const s = sweep(
      [entry(OLD_A), entry(OLD_B), entry(OTHER_PR)],
      (prNumber) => ({
        active: [prNumber === 43],
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD, [OTHER_PR]: OLD },
      }),
    );
    await s.run();
    expect([s.seenPrs, s.removed]).toEqual([
      [42, 43],
      [OLD_A, OLD_B],
    ]);
  });

  test("ignores the main clone, other worktrees, and worktrees that are not detached", async () => {
    const s = sweep(
      [
        MAIN_ENTRY,
        entry(`${PARENT}/dependabot-42-aaaaaaa`),
        entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, { detached: false }),
      ],
      () => ({}),
    );
    await s.run();
    expect(s.seenPrs).toEqual([]);
  });

  test("returns the number of removed worktrees", async () => {
    const s = sweep([entry(OLD_A), entry(OLD_B)], () => ({
      mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
    }));
    expect(await s.run()).toBe(2);
  });

  test("continues with the next repository when listing the worktrees of one fails", async () => {
    const removed: string[] = [];
    const warnings: string[] = [];
    const deps: ReviewWorktreeSweepDeps = {
      findMainRepoDirs: async () => ["/workspaces/acme/broken/main", REPO_DIR],
      listWorktrees: async (repoDir) => {
        if (repoDir.includes("broken")) throw new Error("not a repository");
        return [entry(OLD_A)];
      },
      removalDeps: () => {
        const inner = setup({ mtimes: { [OLD_A]: OLD } });
        return {
          ...inner.deps,
          removeWorktree: async (dir) => {
            removed.push(dir);
          },
        };
      },
      warn: (message) => warnings.push(message),
    };
    await removeStaleReviewWorktrees(deps, CUTOFF);
    expect([removed, warnings]).toEqual([
      [OLD_A],
      ["cleanup: failed to list worktrees for review"],
    ]);
  });
});
