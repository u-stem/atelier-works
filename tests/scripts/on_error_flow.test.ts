// Tests for on_error_flow.ts's pure functions:
// - shouldMarkFailed: whether a stale failure_module run (superseded by a
//   newer run's setFlowJobId) is entitled to mark the work item `failed`.
// - failureWorkItemRef: the FK-safe work_item_id for recordFailure, given
//   a (possibly null) getWorkItem lookup result.
// labelsToRemove / shouldSetNeedsHumanLabel were removed by the 2026-09-27
// PR label cleanup: every kind's trigger label is consumed at claim time
// (matching the Issue-side policy from the prior PR), so there is no label
// to remove and no state label to set on a `failed` transition any more.
// See the devil-advocate notes above each function in on_error_flow.ts.

import { describe, expect, test } from "bun:test";
import {
  failureWorkItemRef,
  shouldMarkFailed,
} from "../../f/factory/on_error_flow.ts";

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

describe("failureWorkItemRef", () => {
  test("returns the item's id when the lookup found a row", () => {
    expect(failureWorkItemRef({ id: 42 }, 42)).toBe(42);
  });

  test("returns null when the lookup found no row (avoids the FK violation)", () => {
    expect(failureWorkItemRef(null, 999999)).toBeNull();
  });
});
