// `pr_review_prepare.ts`が使う`pr_workflow_support.ts`の`decideReviewPrepare`と、
// `pr_review_prepare.ts`自身の`buildReviewWorktreeDir`のテスト。
// `buildReviewWorktreeDir`は`cleanup_workspaces.ts`も使う。

import { describe, expect, test } from "bun:test";
import {
  buildReviewWorktreeDir,
  isReviewWorktreeOf,
} from "../../f/factory/steps/pr_review_prepare.ts";
import { decideReviewPrepare } from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildReviewWorktreeDir", () => {
  test("builds the review-<pr>-<sha7> path under the repo's parent dir", () => {
    expect(
      buildReviewWorktreeDir("/workspaces/acme/widgets/main", 42, "abc1234"),
    ).toBe("/workspaces/acme/widgets/review-42-abc1234");
  });
});

describe("isReviewWorktreeOf", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";

  test("matches the path buildReviewWorktreeDir creates", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      true,
    );
  });

  test("does not match a worktree of another pr", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 421, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a worktree that is not detached", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: false })).toBe(
      false,
    );
  });

  test("does not match the same name under another directory", () => {
    const path = "/workspaces/acme/other/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a directory nested below the repo's parent", () => {
    const path = "/workspaces/acme/widgets/x/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a name whose suffix is not a 7-digit hex sha", () => {
    const path = "/workspaces/acme/widgets/review-42-abc1234-extra";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });
});

describe("decideReviewPrepare", () => {
  test("proceeds for a pr_review work item in status reviewing", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "reviewing",
    });
    expect(decision).toEqual({ skip: false });
  });

  test("skips a work item of a different kind", () => {
    const decision = decideReviewPrepare({
      kind: "pr_fix",
      status: "reviewing",
    });
    expect(decision.skip).toBe(true);
  });

  test("skips a pr_review work item that was cancelled", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "cancelled",
    });
    expect(decision.skip).toBe(true);
  });

  test("skip reason mentions the actual status", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "reviewed",
    });
    expect(decision.skip && decision.reason).toContain("reviewed");
  });
});
