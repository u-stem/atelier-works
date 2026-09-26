// Tests for f/factory/steps/pr_workflow_support.ts's buildReviewDiffText and
// isReviewClaudeOutput (used by pr_review_generate.ts), plus a confirmation
// (team-lead: link a human-authored PR to its approved requirements) that
// pr_review_generate.ts's existing `requirements` wiring actually reaches
// lib/prompts.ts's reviewPrompt and activates its requirements-alignment
// section — prompts.ts itself is untouched, this just calls its real
// exported reviewPrompt the same way pr_review_generate.ts's main() does.

import { describe, expect, test } from "bun:test";
import { reviewPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
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
      end_line: null,
      severity: "minor",
      kind: "nits",
      message: "nit",
      suggestion: null,
      suggested_code: null,
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
          end_line: null,
          severity: "high",
          kind: "nits",
          message: "x",
          suggestion: null,
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("rejects a finding with an invalid kind", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          end_line: null,
          severity: "minor",
          kind: "todo",
          message: "x",
          suggestion: null,
          suggested_code: null,
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
          end_line: null,
          severity: "nit",
          kind: "q",
          message: "x",
          suggestion: "y",
          suggested_code: null,
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

const FAKE_PR = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  title: "t",
  body: "b",
  url: "https://github.com/acme/widgets/pull/1",
  head_sha: "abc1234",
  base_ref: "main",
};

const FAKE_REQUIREMENTS: RequirementDraft = {
  id: 1,
  work_item_id: 9,
  attempt: 1,
  summary: "s",
  markdown: "the button must be blue",
  diagrams: [],
  open_questions: [],
  created_at: new Date("2026-01-01"),
};

describe("reviewPrompt requirements wiring", () => {
  // Confirms pr_review_generate.ts's existing `requirements` (from
  // parent_work_item_id -> latestDraft, or now also a Closes-#N-linked
  // issue's approved draft for a human-authored PR) actually activates
  // reviewPrompt's requirements-alignment section, end to end.
  test("includes the approved requirements text when requirements is non-null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: FAKE_REQUIREMENTS,
      openFindings: [],
    });
    expect(prompt).toContain("the button must be blue");
  });

  test("omits the requirements-alignment section when requirements is null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: null,
      openFindings: [],
    });
    expect(prompt).not.toContain("approved requirements");
  });
});
