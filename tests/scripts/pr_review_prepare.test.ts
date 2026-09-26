// Tests for f/factory/steps/pr_workflow_support.ts's decideReviewPrepare
// (used by pr_review_prepare.ts).

import { describe, expect, test } from "bun:test";
import { decideReviewPrepare } from "../../f/factory/steps/pr_workflow_support.ts";

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
