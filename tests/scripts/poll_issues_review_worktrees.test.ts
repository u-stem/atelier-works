// `poll_issues.ts`のPRが閉じたときの片付けのテスト。
// レビュー用のworktreeの選び方と消し方(ロックの扱い)は、定期の片付けと同じ関数を使う。

import { describe, expect, test } from "bun:test";
import { logger } from "../../f/factory/lib/log.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import {
  type ClosedPrWorktreeDeps,
  removeReviewWorktreesOfClosedPr,
} from "../../f/factory/poll_issues.ts";

const REPO_DIR = "/workspaces/acme/widgets/main";
const PARENT = "/workspaces/acme/widgets";

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

function setup(worktrees: readonly WorktreeEntry[], failOn?: string) {
  const removed: {
    dir: string;
    options: { force: true; forceLocked: boolean };
  }[] = [];
  const logLines: string[] = [];
  const deps: ClosedPrWorktreeDeps = {
    listWorktrees: async () => worktrees,
    removeWorktree: async (_repoDir, dir, options) => {
      if (dir === failOn) throw new Error(`cannot remove ${dir}`);
      removed.push({ dir, options });
    },
  };
  const run = (prNumber: number) =>
    removeReviewWorktreesOfClosedPr(
      REPO_DIR,
      prNumber,
      deps,
      logger("poll_issues", { sink: (line) => logLines.push(line) }),
    );
  return { run, removed, logLines };
}

describe("removeReviewWorktreesOfClosedPr", () => {
  test("removes the review worktrees of the pr with or without a run id", async () => {
    const s = setup([
      MAIN_ENTRY,
      entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`),
      entry(`${PARENT}/review-42-bbbbbbb`),
    ]);
    await s.run(42);
    expect(s.removed.map((item) => item.dir)).toEqual([
      `${PARENT}/review-42-aaaaaaa-0a1b2c3d`,
      `${PARENT}/review-42-bbbbbbb`,
    ]);
  });

  test("does not remove the worktrees of another pr or other kinds", async () => {
    const s = setup([
      MAIN_ENTRY,
      entry(`${PARENT}/review-43-aaaaaaa-0a1b2c3d`),
      entry(`${PARENT}/dependabot-42-aaaaaaa`),
    ]);
    await s.run(42);
    expect(s.removed).toEqual([]);
  });

  test("removes an unlocked worktree with force only", async () => {
    const s = setup([
      MAIN_ENTRY,
      entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`),
    ]);
    await s.run(42);
    expect(s.removed[0]?.options).toEqual({ force: true, forceLocked: false });
  });

  test("passes forceLocked for a worktree locked as initializing", async () => {
    const s = setup([
      MAIN_ENTRY,
      entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, {
        lock: { reason: "initializing" },
      }),
    ]);
    await s.run(42);
    expect(s.removed[0]?.options).toEqual({ force: true, forceLocked: true });
  });

  test("keeps a worktree locked for another reason and goes on to the next", async () => {
    const s = setup([
      MAIN_ENTRY,
      entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, {
        lock: { reason: "on a usb drive" },
      }),
      entry(`${PARENT}/review-42-bbbbbbb-4e5f6a7b`),
    ]);
    await s.run(42);
    expect(s.removed.map((item) => item.dir)).toEqual([
      `${PARENT}/review-42-bbbbbbb-4e5f6a7b`,
    ]);
  });

  test("goes on to the next worktree after one fails to be removed", async () => {
    const first = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
    const second = `${PARENT}/review-42-bbbbbbb-4e5f6a7b`;
    const s = setup([MAIN_ENTRY, entry(first), entry(second)], first);
    await s.run(42);
    expect(s.removed.map((item) => item.dir)).toEqual([second]);
  });
});
