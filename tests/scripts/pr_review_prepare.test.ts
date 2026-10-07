// `pr_review_prepare.ts`が使う`pr_workflow_support.ts`の`decideReviewPrepare`と、
// `pr_review_prepare.ts`自身の`buildReviewWorktreeDir`のテスト。
// `buildReviewWorktreeDir`は`cleanup_workspaces.ts`も使う。

import { describe, expect, test } from "bun:test";
import { buildReviewWorktreeDir } from "../../f/factory/steps/pr_review_prepare.ts";
import { decideReviewPrepare } from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildReviewWorktreeDir", () => {
  test("builds the review-<pr>-<sha7> path under the repo's parent dir", () => {
    expect(
      buildReviewWorktreeDir("/workspaces/acme/widgets/main", 42, "abc1234"),
    ).toBe("/workspaces/acme/widgets/review-42-abc1234");
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
