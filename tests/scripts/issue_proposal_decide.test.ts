// Tests for f/factory/steps/pr_workflow_support.ts's pure helpers backing
// f/factory/issue_proposal_decide.ts (team-lead fix round): idempotency
// classification ([MUST] #2), the marker builder/parser pair used to find
// (and avoid re-creating) an already-approved proposal's Issue ([MUST] #2),
// and the deterministic reply-target choice by `is_inline` ([MUST] #4).

import { describe, expect, test } from "bun:test";
import {
  appendIssueProposalMarker,
  chooseIssueProposalReplyTarget,
  classifyIssueProposalDecision,
  hasIssueProposalMarker,
  issueProposalMarkerSearchTerm,
  issueProposalMarkerText,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("classifyIssueProposalDecision", () => {
  test("proceeds when the row is still pending", () => {
    const result = classifyIssueProposalDecision(
      { status: "pending", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({ action: "proceed" });
  });

  test("reposts only when already approved but the Issue was not yet created", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  // `IssueProposalDecisionRow` carries no `with_factory_label` field, so a
  // retry's `with_factory_label` can never change this classification —
  // issue_proposal_decide.ts's approve path also reads the *stored*
  // `current.with_factory_label` (the value recorded by the original
  // approval), not the value passed to this retry, when it re-attempts
  // Issue creation: the first approval's choice always wins, whatever a
  // later retry requests.
  test("reposts only regardless of the retry's with_factory_label value", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: true },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  test("reposts only when a reject decision is retried", () => {
    const result = classifyIssueProposalDecision(
      { status: "rejected", created_issue_number: null },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  test("refuses when already decided differently (approved, now asked to reject)", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: 42 },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    expect(result.action).toBe("refuse");
  });

  test("refuses when already decided differently (rejected, now asked to approve)", () => {
    const result = classifyIssueProposalDecision(
      { status: "rejected", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result.action).toBe("refuse");
  });

  test("refuses as already done when approved and the Issue was already created", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: 42 },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({
      action: "refuse",
      message: "この提案は既に承認済みで、Issue #42も作成済みです",
    });
  });

  test("refuse messages are Japanese and mention the conflicting decision", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    if (result.action !== "refuse") {
      throw new Error("expected a refuse classification");
    }
    expect(result.message).toContain("承認");
    expect(result.message).toContain("却下");
  });
});

describe("issueProposalMarkerSearchTerm / issueProposalMarkerText", () => {
  test("the search term has no HTML comment syntax", () => {
    expect(issueProposalMarkerSearchTerm(5)).toBe("factory:issue_proposal:5");
  });

  test("the marker text wraps the search term in an HTML comment", () => {
    expect(issueProposalMarkerText(5)).toBe(
      "<!-- factory:issue_proposal:5 -->",
    );
  });
});

describe("appendIssueProposalMarker / hasIssueProposalMarker", () => {
  test("appends the marker after a blank line", () => {
    const body = appendIssueProposalMarker("背景\n提案", 5);
    expect(body).toBe("背景\n提案\n\n<!-- factory:issue_proposal:5 -->");
  });

  test("hasIssueProposalMarker finds a marker built by appendIssueProposalMarker", () => {
    const body = appendIssueProposalMarker("背景", 5);
    expect(hasIssueProposalMarker(body, 5)).toBe(true);
  });

  test("hasIssueProposalMarker does not match a different proposal id", () => {
    const body = appendIssueProposalMarker("背景", 5);
    expect(hasIssueProposalMarker(body, 50)).toBe(false);
  });

  test("hasIssueProposalMarker returns false for plain text with no marker", () => {
    expect(hasIssueProposalMarker("just an issue body", 5)).toBe(false);
  });
});

describe("chooseIssueProposalReplyTarget", () => {
  test("chooses inline for an inline review comment", () => {
    expect(chooseIssueProposalReplyTarget(true)).toBe("inline");
  });

  test("chooses issue_comment for a plain issue comment", () => {
    expect(chooseIssueProposalReplyTarget(false)).toBe("issue_comment");
  });
});
