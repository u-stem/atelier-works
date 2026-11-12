// `cleanup_workspaces.ts`のレビュー用の作業ツリーの片付けのテスト。
// そのPRの`pr_review`の作業項目のうち、更新が最も新しいものが終端で、期限を過ぎているときだけ、
// そのPR番号のレビュー用の作業ツリーを、shaと実行の識別子の有無を問わず消す。
// 消す直前の確認は、PRごとに1回だけ行う。

import { describe, expect, test } from "bun:test";
import {
  type ReviewWorktreeRemovalDeps,
  removeReviewWorktrees,
  reviewWorktreesAreDue,
  selectReviewWorktreesOfPr,
} from "../../f/factory/cleanup_workspaces.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";

const REPO_DIR = "/workspaces/acme/widgets/main";
const PARENT = "/workspaces/acme/widgets";
const CUTOFF = new Date("2026-11-05T00:00:00Z");
const BEFORE_CUTOFF = new Date("2026-11-04T00:00:00Z");
const AFTER_CUTOFF = new Date("2026-11-06T00:00:00Z");

/** 識別子の無い形(`review-<PR番号>-<sha7>`)。 */
const NO_RUN_ID = `${PARENT}/review-42-aaaaaaa`;
const WITH_RUN_A = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
const WITH_RUN_B = `${PARENT}/review-42-aaaaaaa-4e5f6a7b`;
/** 準備の後にheadが動いて、作業項目のheadとは別のshaになった作業ツリー。 */
const OTHER_SHA = `${PARENT}/review-42-bbbbbbb-0a1b2c3d`;
const OTHER_PR = `${PARENT}/review-43-aaaaaaa-0a1b2c3d`;

type Latest = Pick<WorkItem, "status" | "updated_at">;

const OLD_TERMINAL: Latest = { status: "reviewed", updated_at: BEFORE_CUTOFF };
const NEW_TERMINAL: Latest = { status: "failed", updated_at: AFTER_CUTOFF };
const OLD_RUNNING: Latest = { status: "reviewing", updated_at: BEFORE_CUTOFF };

function entry(
  path: string,
  overrides: Partial<Pick<WorktreeEntry, "detached">> = {},
): Pick<WorktreeEntry, "path" | "detached"> {
  return { path, detached: true, ...overrides };
}

describe("reviewWorktreesAreDue", () => {
  test("is true when the latest review is terminal and older than the cutoff", () => {
    expect(reviewWorktreesAreDue(OLD_TERMINAL, CUTOFF)).toBe(true);
  });

  test("is true when the latest review was updated exactly at the cutoff", () => {
    expect(
      reviewWorktreesAreDue({ status: "reviewed", updated_at: CUTOFF }, CUTOFF),
    ).toBe(true);
  });

  test("is false when the latest review is terminal but newer than the cutoff", () => {
    expect(reviewWorktreesAreDue(NEW_TERMINAL, CUTOFF)).toBe(false);
  });

  test("is false when the latest review is not terminal even if it is old", () => {
    expect(reviewWorktreesAreDue(OLD_RUNNING, CUTOFF)).toBe(false);
  });

  test("is true when no review remains for the pr", () => {
    expect(reviewWorktreesAreDue(null, CUTOFF)).toBe(true);
  });
});

describe("selectReviewWorktreesOfPr", () => {
  test("selects every review worktree of the pr with or without a run id", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [entry(NO_RUN_ID), entry(WITH_RUN_A), entry(WITH_RUN_B)],
        42,
      ),
    ).toEqual([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
  });

  test("selects a worktree whose sha7 differs from the head of any work item", () => {
    expect(selectReviewWorktreesOfPr(REPO_DIR, [entry(OTHER_SHA)], 42)).toEqual(
      [OTHER_SHA],
    );
  });

  test("does not select a worktree of another pr", () => {
    expect(selectReviewWorktreesOfPr(REPO_DIR, [entry(OTHER_PR)], 42)).toEqual(
      [],
    );
  });

  test("does not select a worktree that is not detached", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [entry(WITH_RUN_A, { detached: false })],
        42,
      ),
    ).toEqual([]);
  });

  test("does not select the same name outside the repository's parent directory", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [entry("/workspaces/acme/other/review-42-aaaaaaa-0a1b2c3d")],
        42,
      ),
    ).toEqual([]);
  });

  test("does not select a directory nested below the repository's parent", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [entry(`${PARENT}/x/review-42-aaaaaaa-0a1b2c3d`)],
        42,
      ),
    ).toEqual([]);
  });

  test("does not select a run id with the wrong length or an uppercase letter", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [
          entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3`),
          entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d4`),
          entry(`${PARENT}/review-42-aaaaaaa-0A1B2C3D`),
        ],
        42,
      ),
    ).toEqual([]);
  });

  test("does not select a dependabot worktree", () => {
    expect(
      selectReviewWorktreesOfPr(
        REPO_DIR,
        [entry(`${PARENT}/dependabot-42-aaaaaaa`)],
        42,
      ),
    ).toEqual([]);
  });
});

describe("removeReviewWorktrees", () => {
  type Setup = {
    readonly latest?: Latest | null;
    readonly latestFails?: boolean;
    readonly free?: (dir: string) => boolean;
    readonly ensureFreeFails?: (dir: string) => boolean;
    readonly removeFails?: (dir: string) => boolean;
  };

  function setup(options: Setup = {}) {
    const removedCalls: string[] = [];
    const warnings: { message: string; fields: LogFields }[] = [];
    let lookups = 0;
    const deps: ReviewWorktreeRemovalDeps = {
      ensureFree: async (dir) => {
        if (options.ensureFreeFails?.(dir) === true) {
          throw new Error(`cannot check ${dir}`);
        }
        return options.free?.(dir) ?? true;
      },
      latestReview: async () => {
        lookups += 1;
        if (options.latestFails === true) throw new Error("database is down");
        return options.latest === undefined ? OLD_TERMINAL : options.latest;
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
        {
          repoDir: REPO_DIR,
          prNumber: 42,
          targetDirs,
          cutoff: CUTOFF,
          visited,
        },
        deps,
      );
    return { run, removedCalls, warnings, visited, lookups: () => lookups };
  }

  test("removes every worktree when the latest review is terminal and past the cutoff", async () => {
    const s = setup();
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("records the removed worktrees as visited", async () => {
    const s = setup();
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.removed]).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("removes nothing when a newer review is still within the cutoff", async () => {
    const s = setup({ latest: NEW_TERMINAL });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([]);
  });

  test("removes nothing when the latest review is still running", async () => {
    const s = setup({ latest: OLD_RUNNING });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.removedCalls).toEqual([]);
  });

  test("marks every worktree skipped when the review is not due", async () => {
    const s = setup({ latest: NEW_TERMINAL });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.skipped]).toEqual([NO_RUN_ID, WITH_RUN_A]);
  });

  test("looks up the latest review once for all the worktrees of the pr", async () => {
    const s = setup();
    await s.run([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
    expect(s.lookups()).toBe(1);
  });

  test("does not look up again for worktrees already skipped in the same run", async () => {
    const s = setup({ latest: NEW_TERMINAL });
    await s.run([NO_RUN_ID]);
    await s.run([NO_RUN_ID]);
    expect(s.lookups()).toBe(1);
  });

  test("removes nothing and tries no other worktree when the lookup fails", async () => {
    const s = setup({ latestFails: true });
    await s.run([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
    expect(s.removedCalls).toEqual([]);
  });

  test("looks up once and records one warning when the lookup fails", async () => {
    const s = setup({ latestFails: true });
    await s.run([NO_RUN_ID, WITH_RUN_A, WITH_RUN_B]);
    expect(s.warnings.map((warning) => warning.message)).toEqual([
      "cleanup: failed to re-check active pr_review",
    ]);
  });

  test("names the cause of the lookup failure in the warning", async () => {
    const s = setup({ latestFails: true });
    await s.run([NO_RUN_ID]);
    expect(s.warnings[0]?.fields.error).toBe("database is down");
  });

  test("marks every worktree skipped when the lookup fails", async () => {
    const s = setup({ latestFails: true });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.skipped]).toEqual([NO_RUN_ID, WITH_RUN_A]);
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

  test("marks a worktree in use as skipped", async () => {
    const s = setup({ free: (dir) => dir !== NO_RUN_ID });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect([...s.visited.skipped]).toEqual([NO_RUN_ID]);
  });

  test("does not look up the latest review when every worktree is in use", async () => {
    const s = setup({ free: () => false });
    await s.run([NO_RUN_ID, WITH_RUN_A]);
    expect(s.lookups()).toBe(0);
  });

  test("continues with the next worktree when checking one throws", async () => {
    const s = setup({ ensureFreeFails: (dir) => dir === NO_RUN_ID });
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
    const targets = selectReviewWorktreesOfPr(
      REPO_DIR,
      [entry(WITH_RUN_A), entry(OTHER_PR)],
      42,
    );
    await s.run(targets);
    expect(s.removedCalls).toEqual([WITH_RUN_A]);
  });
});
