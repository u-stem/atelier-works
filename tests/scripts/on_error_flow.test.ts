// Tests for on_error_flow.ts's pure functions:
// - labelsToRemove: the label set an exception-driven `failed` transition
//   removes. Issue kind is empty (2026-09-27 policy: the `factory` trigger
//   label is consumed at claim time, so there is nothing left to remove);
//   PR kinds are kept symmetric with retry_work_item.ts's labelsToRestore.
// - shouldMarkFailed: whether a stale failure_module run (superseded by a
//   newer run's setFlowJobId) is entitled to mark the work item `failed`.
// - shouldSetNeedsHumanLabel: whether the PR state label needs_human_label
//   is set for a failed work item.
// - failureWorkItemRef: the FK-safe work_item_id for recordFailure, given
//   a (possibly null) getWorkItem lookup result.
// See the devil-advocate notes above each function in on_error_flow.ts.

import { describe, expect, test } from "bun:test";
import {
  failureWorkItemRef,
  labelsToRemove,
  shouldMarkFailed,
  shouldSetNeedsHumanLabel,
} from "../../f/factory/on_error_flow.ts";

const LABEL_CONFIG = {
  wip_label: "factory:wip",
  trigger_label: "factory",
  review_label: "factory:review",
  fix_label: "factory:fix",
};

describe("labelsToRemove", () => {
  test("removes nothing for an issue work item (trigger label already consumed at claim)", () => {
    expect(labelsToRemove("issue", LABEL_CONFIG)).toEqual([]);
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

describe("failureWorkItemRef", () => {
  test("returns the item's id when the lookup found a row", () => {
    expect(failureWorkItemRef({ id: 42 }, 42)).toBe(42);
  });

  test("returns null when the lookup found no row (avoids the FK violation)", () => {
    expect(failureWorkItemRef(null, 999999)).toBeNull();
  });
});
