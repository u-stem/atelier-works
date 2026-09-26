// Tests for f/factory/steps/pr_workflow_support.ts's buildFixCommitMessage
// and isFixClaudeOutput (used by pr_fix_apply.ts).

import { describe, expect, test } from "bun:test";
import {
  buildFixCommitMessage,
  isFixClaudeOutput,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildFixCommitMessage", () => {
  test("uses the summary's first line as the subject", () => {
    const message = buildFixCommitMessage("address null check\nmore detail", 1);
    expect(message).toBe("fix: address null check");
  });

  test("prefixes with the Conventional Commits fix: type", () => {
    const message = buildFixCommitMessage("do the thing", 1);
    expect(message.startsWith("fix: ")).toBe(true);
  });

  test("falls back to a round-based subject when the summary is blank", () => {
    const message = buildFixCommitMessage("   ", 2);
    expect(message).toBe("fix: address round 2 review feedback");
  });

  test("truncates an overly long subject", () => {
    const longSummary = "x".repeat(200);
    const message = buildFixCommitMessage(longSummary, 1);
    expect(message.length).toBeLessThanOrEqual("fix: ".length + 72);
  });
});

const VALID_OUTPUT = {
  outcome: "done",
  summary: "fixed it",
  replies: [{ review_comment_id: 1, body: "done" }],
  blocked_reason: null,
};

describe("isFixClaudeOutput", () => {
  test("accepts a well-formed done output", () => {
    expect(isFixClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects an invalid outcome", () => {
    expect(isFixClaudeOutput({ ...VALID_OUTPUT, outcome: "wontfix" })).toBe(
      false,
    );
  });

  test("accepts a blocked outcome with a blocked_reason", () => {
    const output = {
      ...VALID_OUTPUT,
      outcome: "blocked",
      blocked_reason: "unsafe",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a reply missing review_comment_id", () => {
    const output = { ...VALID_OUTPUT, replies: [{ body: "done" }] };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a non-string, non-null blocked_reason", () => {
    const output = { ...VALID_OUTPUT, blocked_reason: 42 };
    expect(isFixClaudeOutput(output)).toBe(false);
  });
});
