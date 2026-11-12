// `cleanup_workspaces.ts`のレビュー用の作業ツリーの片付けのテスト。
// 期限を過ぎた終端の`pr_review`の作業項目について、そのPR番号のレビュー用の作業ツリーを、
// shaと実行の識別子の有無を問わず選ぶ。
// 同じPRに終端でない`pr_review`があるときは、選ぶときも消す直前も、何も消さない。

import { describe, expect, test } from "bun:test";
import {
  hasActivePrReview,
  type ReviewWorktreeRemovalDeps,
  removeReviewWorktrees,
  selectReviewWorktreesToRemove,
} from "../../f/factory/cleanup_workspaces.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";

const REPO_DIR = "/workspaces/acme/widgets/main";
const PARENT = "/workspaces/acme/widgets";

/** 識別子の無い形(`review-<PR番号>-<sha7>`)。 */
const NO_RUN_ID = `${PARENT}/review-42-aaaaaaa`;
const WITH_RUN_A = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
const WITH_RUN_B = `${PARENT}/review-42-aaaaaaa-4e5f6a7b`;
/** 準備の後にheadが動いて、作業項目のheadとは別のshaになった作業ツリー。 */
const OTHER_SHA = `${PARENT}/review-42-bbbbbbb-0a1b2c3d`;
const OTHER_PR = `${PARENT}/review-43-aaaaaaa-0a1b2c3d`;

type ActiveItem = Pick<WorkItem, "kind" | "owner" | "repo" | "pr_number">;

function entry(
  path: string,
  overrides: Partial<Pick<WorktreeEntry, "detached">> = {},
): Pick<WorktreeEntry, "path" | "detached"> {
  return { path, detached: true, ...overrides };
}

function active(overrides: Partial<ActiveItem> = {}): ActiveItem {
  return {
    kind: "pr_review",
    owner: "acme",
    repo: "widgets",
    pr_number: 42,
    ...overrides,
  };
}

describe("hasActivePrReview", () => {
  test("is true when a running pr_review of the same pr exists", () => {
    expect(hasActivePrReview(REPO_DIR, 42, [active()])).toBe(true);
  });

  test("is false when the running pr_review belongs to another pr", () => {
    expect(hasActivePrReview(REPO_DIR, 42, [active({ pr_number: 43 })])).toBe(
      false,
    );
  });

  test("is false when the running pr_review belongs to another repository", () => {
    expect(hasActivePrReview(REPO_DIR, 42, [active({ repo: "gadgets" })])).toBe(
      false,
    );
  });

  test("is false when the running work item of the same pr is not a pr_review", () => {
    expect(hasActivePrReview(REPO_DIR, 42, [active({ kind: "pr_fix" })])).toBe(
      false,
    );
  });

  test("is false when nothing is running", () => {
    expect(hasActivePrReview(REPO_DIR, 42, [])).toBe(false);
  });
});

describe("selectReviewWorktreesToRemove", () => {
  const ITEM = { pr_number: 42 };

  test("selects every review worktree of the pr with or without a run id", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(NO_RUN_ID), entry(WITH_RUN_A), entry(WITH_RUN_B)],
        ITEM,
        [],
      ),
    ).toEqual([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
  });

  test("selects a worktree whose sha7 differs from the head of the work item", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(OTHER_SHA)], ITEM, []),
    ).toEqual([OTHER_SHA]);
  });

  test("does not select a worktree of another pr", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(OTHER_PR)], ITEM, []),
    ).toEqual([]);
  });

  test("does not select a worktree that is not detached", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(WITH_RUN_A, { detached: false })],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select the same name outside the repository's parent directory", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry("/workspaces/acme/other/review-42-aaaaaaa-0a1b2c3d")],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select a directory nested below the repository's parent", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(`${PARENT}/x/review-42-aaaaaaa-0a1b2c3d`)],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select a run id with the wrong length or an uppercase letter", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [
          entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3`),
          entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d4`),
          entry(`${PARENT}/review-42-aaaaaaa-0A1B2C3D`),
        ],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select a dependabot worktree", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(`${PARENT}/dependabot-42-aaaaaaa`)],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("selects nothing while a running pr_review of the same pr exists", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(NO_RUN_ID), entry(WITH_RUN_A)],
        ITEM,
        [active()],
      ),
    ).toEqual([]);
  });

  test("keeps selecting when the running pr_review belongs to another pr", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(WITH_RUN_A)], ITEM, [
        active({ pr_number: 43 }),
      ]),
    ).toEqual([WITH_RUN_A]);
  });

  test("selects nothing for a work item without a pr number", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(WITH_RUN_A)],
        { pr_number: null },
        [],
      ),
    ).toEqual([]);
  });
});

describe("removeReviewWorktrees", () => {
  type Setup = {
    readonly free?: (dir: string) => boolean;
    readonly activeReviews?: () => readonly ActiveItem[];
    readonly removeFails?: (dir: string) => boolean;
  };

  function setup(options: Setup = {}) {
    const removedCalls: string[] = [];
    const warnings: { message: string; fields: LogFields }[] = [];
    let rechecks = 0;
    const deps: ReviewWorktreeRemovalDeps = {
      ensureFree: async (dir) => options.free?.(dir) ?? true,
      listActiveReviews: async () => {
        rechecks += 1;
        return options.activeReviews?.() ?? [];
      },
      removeWorktree: async (dir) => {
        if (options.removeFails?.(dir) === true) {
          throw new Error(`cannot remove ${dir}`);
        }
        removedCalls.push(dir);
      },
      warn: (message, fields) => warnings.push({ message, fields }),
    };
    const visited = { removed: new Set<string>(), skipped: new Set<string>() };
    const run = (targetDirs: readonly string[]) =>
      removeReviewWorktrees(
        { repoDir: REPO_DIR, prNumber: 42, targetDirs, visited },
        deps,
      );
    return { run, removedCalls, warnings, visited, rechecks: () => rechecks };
  }

  test("removes every selected worktree", async () => {
    const s = setup();
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("records the removed worktrees as visited", async () => {
    const s = setup();
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.removed]).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("removes nothing when the recheck finds a review that started", async () => {
    const s = setup({ activeReviews: () => [active()] });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([]);
  });

  test("marks every worktree skipped when the recheck finds a review that started", async () => {
    const s = setup({ activeReviews: () => [active()] });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.skipped]).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("stops rechecking after the first review that started", async () => {
    const s = setup({ activeReviews: () => [active()] });
    await s.run([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
    expect(s.rechecks()).toBe(1);
  });

  test("does not try a worktree skipped by the recheck again in the same run", async () => {
    const s = setup({ activeReviews: () => [active()] });
    await s.run([NO_RUN_ID]);
    await s.run([NO_RUN_ID]);
    expect(s.rechecks()).toBe(1);
  });

  test("removes the worktrees of the pr when the running review belongs to another pr", async () => {
    const s = setup({ activeReviews: () => [active({ pr_number: 43 })] });
    await s.run([WITH_RUN_A]);
    expect(s.removedCalls).toEqual([WITH_RUN_A]);
  });

  test("continues with the next worktree after one fails to be removed", async () => {
    const s = setup({ removeFails: (dir) => dir === NO_RUN_ID });
    await s.run([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
    expect(s.removedCalls).toEqual([WITH_RUN_A, WITH_RUN_B]);
  });

  test("records a warning with the path of the worktree that failed", async () => {
    const s = setup({ removeFails: (dir) => dir === NO_RUN_ID });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.warnings.map((warning) => warning.fields.worktree_dir)).toEqual([
      NO_RUN_ID,
    ]);
  });

  test("does not try a worktree that failed again in the same run", async () => {
    const s = setup({ removeFails: () => true });
    await s.run([NO_RUN_ID]);
    await s.run([NO_RUN_ID]);
    expect(s.warnings).toHaveLength(1);
  });

  test("continues with the next worktree when the first is in use", async () => {
    const s = setup({ free: (dir) => dir !== NO_RUN_ID });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([WITH_RUN_A]);
  });

  test("skips a worktree that was already removed in this run", async () => {
    const s = setup();
    await s.run([WITH_RUN_A]);
    await s.run([WITH_RUN_A, WITH_RUN_B]);
    expect(s.removedCalls).toEqual([WITH_RUN_A, WITH_RUN_B]);
  });

  test("removes only the worktrees of the pr when it follows the selection", async () => {
    const s = setup();
    const targets = selectReviewWorktreesToRemove(
      REPO_DIR,
      [entry(WITH_RUN_A), entry(OTHER_PR)],
      { pr_number: 42 },
      [],
    );
    await s.run(targets);
    expect(s.removedCalls).toEqual([WITH_RUN_A]);
  });
});
