// Tests for f/factory/steps/pr_workflow_support.ts's openFindingsForPrompt
// (team-lead decision, 2026-09-26: a re-review must not re-post a finding
// substantially the same as one that's already open — used by
// pr_review_generate.ts to build reviewPrompt's `openFindings` input).

import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../f/factory/lib/github.ts";
import { openFindingsForPrompt } from "../../f/factory/steps/pr_workflow_support.ts";

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    path: "a.ts",
    line: 10,
    firstCommentAuthorLogin: "factory-bot",
    firstCommentBody: "[pr_review 自動レビュー]\n[MUST] fix this",
    lastCommentAuthorLogin: "factory-bot",
    lastCommentBody: "[pr_review 自動レビュー]\n[MUST] fix this",
    firstCommentDatabaseId: 1,
    allCommentIds: [1],
    ...overrides,
  };
}

describe("openFindingsForPrompt", () => {
  test("maps an open factory-authored pr_review thread to path/line/body", () => {
    const findings = openFindingsForPrompt([thread()], "factory-bot");
    expect(findings).toEqual([
      { path: "a.ts", line: 10, body: "[MUST] fix this" },
    ]);
  });

  test("strips the pr_review role-tag line from the body", () => {
    const findings = openFindingsForPrompt([thread()], "factory-bot");
    expect(findings[0]?.body).not.toContain("[pr_review 自動レビュー]");
  });

  test("skips a thread GitHub already marked resolved", () => {
    const findings = openFindingsForPrompt(
      [thread({ isResolved: true })],
      "factory-bot",
    );
    expect(findings).toEqual([]);
  });

  test("skips a thread whose first comment was authored by someone else", () => {
    const findings = openFindingsForPrompt(
      [thread({ firstCommentAuthorLogin: "alice" })],
      "factory-bot",
    );
    expect(findings).toEqual([]);
  });

  test("skips a thread whose first comment has no pr_review role tag", () => {
    const findings = openFindingsForPrompt(
      [thread({ firstCommentBody: "just a plain comment" })],
      "factory-bot",
    );
    expect(findings).toEqual([]);
  });

  test("matches the viewer login case-insensitively", () => {
    const findings = openFindingsForPrompt(
      [thread({ firstCommentAuthorLogin: "Factory-Bot" })],
      "factory-bot",
    );
    expect(findings).toHaveLength(1);
  });

  // team-lead decision (2026-09-26): unlike selectThreadsToResolve, this is
  // independent of who last replied — a finding is still "open" even if a
  // human (or the factory's own pr_fix) replied without actually resolving
  // the GitHub thread.
  test("includes a thread even when the last comment is a human reply", () => {
    const findings = openFindingsForPrompt(
      [
        thread({
          lastCommentAuthorLogin: "alice",
          lastCommentBody: "not fixing this",
        }),
      ],
      "factory-bot",
    );
    expect(findings).toHaveLength(1);
  });

  test("returns an empty array when there are no threads (a PR's first review)", () => {
    expect(openFindingsForPrompt([], "factory-bot")).toEqual([]);
  });

  test("passes through a null line unchanged", () => {
    const findings = openFindingsForPrompt(
      [thread({ line: null })],
      "factory-bot",
    );
    expect(findings[0]?.line).toBeNull();
  });
});
