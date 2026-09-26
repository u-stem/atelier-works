// Tests for on_error_flow.ts's pure functions:
// - labelsToRemove: the label set an exception-driven `failed` transition
//   removes, kept symmetric with retry_work_item.ts's labelsToRestore.
// - shouldMarkFailed: whether a stale failure_module run (superseded by a
//   newer run's setFlowJobId) is entitled to mark the work item `failed`.
// - shouldPostFailureComment: whether the failure comment is posted to the
//   GitHub issue/PR (issue only — team-lead decision, 2026-09-26).
// - truncateForComment: caps the masked error text embedded in the
//   failure comment posted to GitHub.
// - failureWorkItemRef: the FK-safe work_item_id for recordFailure, given
//   a (possibly null) getWorkItem lookup result.
// See the devil-advocate notes above each function in on_error_flow.ts.

import { describe, expect, test } from "bun:test";
import {
  failureWorkItemRef,
  labelsToRemove,
  shouldMarkFailed,
  shouldPostFailureComment,
  shouldSetNeedsHumanLabel,
  truncateForComment,
} from "../../f/factory/on_error_flow.ts";

const LABEL_CONFIG = {
  wip_label: "factory:wip",
  trigger_label: "factory",
  review_label: "factory:review",
  fix_label: "factory:fix",
};

describe("labelsToRemove", () => {
  test("removes wip + trigger_label for an issue work item", () => {
    expect(labelsToRemove("issue", LABEL_CONFIG)).toEqual([
      "factory:wip",
      "factory",
    ]);
  });

  test("removes wip + review_label for a pr_review work item", () => {
    expect(labelsToRemove("pr_review", LABEL_CONFIG)).toEqual([
      "factory:wip",
      "factory:review",
    ]);
  });

  test("removes wip + fix_label for a pr_fix work item", () => {
    expect(labelsToRemove("pr_fix", LABEL_CONFIG)).toEqual([
      "factory:wip",
      "factory:fix",
    ]);
  });
});

describe("shouldMarkFailed", () => {
  test("marks failed when the work item's flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a")).toBe(true);
  });

  test("does not mark failed when a newer run's job id has replaced it", () => {
    expect(shouldMarkFailed("job-b", "job-a")).toBe(false);
  });

  test("marks failed when the work item has no recorded flow_job_id yet", () => {
    expect(shouldMarkFailed(null, "job-a")).toBe(true);
  });

  test("marks failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null)).toBe(true);
  });
});

describe("shouldPostFailureComment", () => {
  // team-lead decision (2026-09-26): a PR must carry only the first-pass
  // review itself and replies to review comments, never an operational
  // notice such as this failure comment.
  test("posts a failure comment for an issue work item", () => {
    expect(shouldPostFailureComment("issue")).toBe(true);
  });

  test("does not post a failure comment for a pr_review work item", () => {
    expect(shouldPostFailureComment("pr_review")).toBe(false);
  });

  test("does not post a failure comment for a pr_fix work item", () => {
    expect(shouldPostFailureComment("pr_fix")).toBe(false);
  });
});

describe("shouldSetNeedsHumanLabel", () => {
  // team-lead design (2026-09-26): needs_human_label covers a failed
  // pr_review as well as a failed pr_fix — both PR kinds get it here.
  test("does not set a state label for an issue work item", () => {
    expect(shouldSetNeedsHumanLabel("issue")).toBe(false);
  });

  test("sets the state label for a pr_review work item", () => {
    expect(shouldSetNeedsHumanLabel("pr_review")).toBe(true);
  });

  test("sets the state label for a pr_fix work item", () => {
    expect(shouldSetNeedsHumanLabel("pr_fix")).toBe(true);
  });
});

describe("truncateForComment", () => {
  test("returns text unchanged when it fits within max", () => {
    expect(truncateForComment("short error", 300)).toBe("short error");
  });

  test("truncates with a trailing ellipsis when text exceeds max", () => {
    const text = "x".repeat(310);
    expect(truncateForComment(text, 300)).toBe(`${"x".repeat(299)}…`);
  });

  test("keeps the truncated result at exactly max characters", () => {
    const text = "x".repeat(310);
    expect(truncateForComment(text, 300).length).toBe(300);
  });
});

describe("failureWorkItemRef", () => {
  test("returns the item's id when the lookup found a row", () => {
    expect(failureWorkItemRef({ id: 42 }, 42)).toBe(42);
  });

  test("returns null when the lookup found no row (avoids the FK violation)", () => {
    expect(failureWorkItemRef(null, 999999)).toBeNull();
  });
});
