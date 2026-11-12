// `cleanup_workspaces.ts`のレビュー用の作業ツリーの選び方のテスト。
// 期限を過ぎた終端の`pr_review`の作業項目について、そのPR番号とsha7に合うレビュー用の作業ツリーを、
// 名前に実行の識別子が付かない古い形と、付いた形の両方で選ぶ。
// 同じPRに終端でない`pr_review`があるときは、何も選ばない。

import { describe, expect, test } from "bun:test";
import { selectReviewWorktreesToRemove } from "../../f/factory/cleanup_workspaces.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import { buildReviewWorktreeDir } from "../../f/factory/steps/pr_review_prepare.ts";

const REPO_DIR = "/workspaces/acme/widgets/main";
const SHA7 = "aaaaaaa";
const OTHER_SHA7 = "bbbbbbb";
const RUN_A = "0a1b2c3d";
const RUN_B = "4e5f6a7b";

const LEGACY = buildReviewWorktreeDir(REPO_DIR, 42, SHA7, null);
const WITH_RUN_A = buildReviewWorktreeDir(REPO_DIR, 42, SHA7, RUN_A);
const WITH_RUN_B = buildReviewWorktreeDir(REPO_DIR, 42, SHA7, RUN_B);

type SelectItem = Pick<WorkItem, "owner" | "repo" | "pr_number" | "head_sha">;
type ActiveItem = Pick<WorkItem, "kind" | "owner" | "repo" | "pr_number">;

const ITEM: SelectItem = {
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: SHA7.repeat(6).slice(0, 40),
};

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

describe("selectReviewWorktreesToRemove", () => {
  test("selects every review worktree of the pr and sha7 in both name forms", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(LEGACY), entry(WITH_RUN_A), entry(WITH_RUN_B)],
        ITEM,
        [],
      ),
    ).toEqual([LEGACY, WITH_RUN_A, WITH_RUN_B]);
  });

  test("selects the worktree that carries a run id", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(WITH_RUN_A)], ITEM, []),
    ).toEqual([WITH_RUN_A]);
  });

  test("does not select a worktree of another sha7", () => {
    const other = buildReviewWorktreeDir(REPO_DIR, 42, OTHER_SHA7, RUN_A);
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(other)], ITEM, []),
    ).toEqual([]);
  });

  test("does not select a worktree of another pr", () => {
    const other = buildReviewWorktreeDir(REPO_DIR, 421, SHA7, RUN_A);
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(other)], ITEM, []),
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
        [entry(`/workspaces/acme/other/review-42-${SHA7}-${RUN_A}`)],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select a directory nested below the repository's parent", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(`/workspaces/acme/widgets/x/review-42-${SHA7}-${RUN_A}`)],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("does not select a run id with the wrong length or an uppercase letter", () => {
    const base = "/workspaces/acme/widgets";
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [
          entry(`${base}/review-42-${SHA7}-0a1b2c3`),
          entry(`${base}/review-42-${SHA7}-0a1b2c3d4`),
          entry(`${base}/review-42-${SHA7}-0A1B2C3D`),
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
        [entry(`/workspaces/acme/widgets/dependabot-42-${SHA7}`)],
        ITEM,
        [],
      ),
    ).toEqual([]);
  });

  test("selects nothing while a running pr_review of the same pr exists", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(LEGACY), entry(WITH_RUN_A)],
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

  test("keeps selecting when the running pr_review belongs to another repository", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(WITH_RUN_A)], ITEM, [
        active({ repo: "gadgets" }),
      ]),
    ).toEqual([WITH_RUN_A]);
  });

  test("keeps selecting when the running work item of the same pr is not a pr_review", () => {
    expect(
      selectReviewWorktreesToRemove(REPO_DIR, [entry(WITH_RUN_A)], ITEM, [
        active({ kind: "pr_fix" }),
      ]),
    ).toEqual([WITH_RUN_A]);
  });

  test("selects nothing for a work item without a pr number or head", () => {
    expect(
      selectReviewWorktreesToRemove(
        REPO_DIR,
        [entry(WITH_RUN_A)],
        { ...ITEM, head_sha: null },
        [],
      ),
    ).toEqual([]);
  });
});
