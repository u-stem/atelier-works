// Tests for f/factory/steps/pr_workflow_support.ts's
// mapFindingsToReviewComments and buildReviewBody (used by pr_review_post.ts).

import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "../../f/factory/lib/types.ts";
import {
  buildReviewBody,
  mapFindingsToReviewComments,
} from "../../f/factory/steps/pr_workflow_support.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "a.ts",
    line: 10,
    severity: "major",
    message: "problem",
    suggestion: null,
    ...overrides,
  };
}

describe("mapFindingsToReviewComments", () => {
  test("maps a finding whose path is in the PR files to an inline comment", () => {
    const { comments } = mapFindingsToReviewComments([finding()], ["a.ts"]);
    expect(comments).toHaveLength(1);
  });

  test("inline comment uses side RIGHT", () => {
    const { comments } = mapFindingsToReviewComments([finding()], ["a.ts"]);
    expect(comments[0]?.side).toBe("RIGHT");
  });

  test("drops a finding whose path is not among the PR files", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("counts a dropped out-of-diff finding", () => {
    const { droppedCount } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      ["a.ts"],
    );
    expect(droppedCount).toBe(1);
  });

  test("drops a finding with a null line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: null })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("drops a finding with a non-positive line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 0 })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("finding body includes the severity", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ severity: "blocker" })],
      ["a.ts"],
    );
    expect(comments[0]?.body).toContain("blocker");
  });

  test("finding body includes a suggestion when present", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ suggestion: "use const" })],
      ["a.ts"],
    );
    expect(comments[0]?.body).toContain("use const");
  });
});

describe("buildReviewBody", () => {
  test("includes the summary", () => {
    const body = buildReviewBody("all good", "approve", 0, 0);
    expect(body).toContain("all good");
  });

  test("includes the verdict", () => {
    const body = buildReviewBody("all good", "request_changes", 0, 0);
    expect(body).toContain("request_changes");
  });

  test("mentions dropped findings when some couldn't be posted inline", () => {
    const body = buildReviewBody("summary", "comment", 5, 2);
    expect(body).toContain("2");
  });

  test("omits the dropped-findings note when nothing was dropped", () => {
    const body = buildReviewBody("summary", "comment", 5, 0);
    expect(body).not.toContain("could not be posted");
  });
});
