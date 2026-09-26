// Tests for f/factory/steps/pr_workflow_support.ts's decideFixFinishAction,
// deriveFallbackReviewers, and evaluateRelabelFailure (used by
// pr_fix_finish.ts).

import { describe, expect, test } from "bun:test";
import {
  decideFixFinishAction,
  deriveFallbackReviewers,
  evaluateRelabelFailure,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("decideFixFinishAction", () => {
  test("routes skip to a no-op", () => {
    expect(decideFixFinishAction("skip", false)).toEqual({ kind: "noop" });
  });

  test("routes done to push", () => {
    expect(decideFixFinishAction("done", false)).toEqual({ kind: "push" });
  });

  test("routes guard_blocked to guard_blocked (not needs_human)", () => {
    expect(decideFixFinishAction("guard_blocked", false)).toEqual({
      kind: "guard_blocked",
    });
  });

  test("routes round_exhausted to needs_human", () => {
    expect(decideFixFinishAction("round_exhausted", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes no_feedback to needs_human", () => {
    expect(decideFixFinishAction("no_feedback", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes Claude's own blocked outcome to needs_human, not blocked", () => {
    expect(decideFixFinishAction("blocked", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes requirements_gap to a reroute when a parent work item exists", () => {
    expect(decideFixFinishAction("requirements_gap", true)).toEqual({
      kind: "requirements_gap_reroute",
    });
  });

  test("routes requirements_gap to needs_human when there is no parent", () => {
    expect(decideFixFinishAction("requirements_gap", false)).toEqual({
      kind: "requirements_gap_needs_human",
    });
  });
});

describe("deriveFallbackReviewers", () => {
  test("combines review and comment authors", () => {
    const reviewers = deriveFallbackReviewers(["alice"], ["bob"]);
    expect(reviewers.sort()).toEqual(["alice", "bob"]);
  });

  test("deduplicates an author appearing in both lists", () => {
    const reviewers = deriveFallbackReviewers(["alice"], ["alice"]);
    expect(reviewers).toEqual(["alice"]);
  });

  test("drops empty logins", () => {
    const reviewers = deriveFallbackReviewers([""], ["bob"]);
    expect(reviewers).toEqual(["bob"]);
  });

  test("returns an empty array when there are no authors", () => {
    expect(deriveFallbackReviewers([], [])).toEqual([]);
  });
});

describe("evaluateRelabelFailure", () => {
  // DA re-verification (fix round 2 follow-up): an addLabels failure used
  // to be swallowed and the requirements_gap reroute proceeded to
  // runFlowAsync anyway, leaving the parent issue's trigger label missing —
  // this must instead abort the reroute with the failure surfaced.
  test("surfaces the addLabels error message when the issue has an issue_number", () => {
    expect(evaluateRelabelFailure(42, "HTTP 403")).toBe("HTTP 403");
  });
});
