// Tests for f/factory/steps/pr_workflow_support.ts's buildReviewDiffText and
// isReviewClaudeOutput (used by pr_review_generate.ts).

import { describe, expect, test } from "bun:test";
import {
  buildReviewDiffText,
  isReviewClaudeOutput,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildReviewDiffText", () => {
  test("returns the diff unchanged when it was not truncated", () => {
    const text = buildReviewDiffText({
      diff: "diff --git a b",
      truncated: false,
      totalLines: 10,
    });
    expect(text).toBe("diff --git a b");
  });

  test("appends a truncation note when the diff was truncated", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("truncated");
  });

  test("truncation note mentions the total line count", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("5000");
  });
});

const VALID_OUTPUT = {
  verdict: "comment",
  summary: "looks fine",
  findings: [
    {
      path: "a.ts",
      line: 3,
      severity: "minor",
      message: "nit",
      suggestion: null,
    },
  ],
};

describe("isReviewClaudeOutput", () => {
  test("accepts a well-formed review output", () => {
    expect(isReviewClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects a non-object value", () => {
    expect(isReviewClaudeOutput("not an object")).toBe(false);
  });

  test("rejects an invalid verdict", () => {
    expect(isReviewClaudeOutput({ ...VALID_OUTPUT, verdict: "lgtm" })).toBe(
      false,
    );
  });

  test("rejects a finding with an invalid severity", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          severity: "high",
          message: "x",
          suggestion: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("accepts a finding with a null line", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: null,
          severity: "nit",
          message: "x",
          suggestion: "y",
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(true);
  });

  test("rejects a missing findings array", () => {
    const { findings: _findings, ...rest } = VALID_OUTPUT;
    expect(isReviewClaudeOutput(rest)).toBe(false);
  });
});
