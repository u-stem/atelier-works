// Tests for f/factory/steps/pr_workflow_support.ts's `propose_issue` pure
// decision helpers (user decision, 2026-09-26): selectProposeIssueReplies /
// matchReviewThreadForComment (pr_fix_finish.ts), and
// buildIssueProposalReason / buildIssueProposalBody /
// renderIssueProposalApprovedReply / renderIssueProposalRejectedReply /
// decidePostProposalStatus (issue_proposal_apply.ts).

import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../f/factory/lib/github.ts";
import type { FixReply } from "../../f/factory/lib/types.ts";
import {
  buildAuditProposalBody,
  buildIssueProposalBody,
  buildIssueProposalReason,
  buildIssueProposalTitle,
  decidePostProposalStatus,
  decidePostProposalTransition,
  matchReviewThreadForComment,
  renderIssueProposalApprovedReply,
  renderIssueProposalRejectedReply,
  selectProposeIssueReplies,
} from "../../f/factory/steps/pr_workflow_support.ts";

function fixReply(overrides: Partial<FixReply> = {}): FixReply {
  return {
    review_comment_id: 1,
    body: "対応します",
    decision: "fixed",
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "PRRT_1",
    isResolved: false,
    path: "a.ts",
    line: 10,
    firstCommentAuthorLogin: "octo-factory",
    firstCommentBody: "[pr_review 自動レビュー]\n[MUST] fix this",
    lastCommentAuthorLogin: "octo-factory",
    lastCommentBody: "[pr_review 自動レビュー]\n[MUST] fix this",
    firstCommentDatabaseId: 101,
    allCommentIds: [101],
    ...overrides,
  };
}

describe("selectProposeIssueReplies", () => {
  test("keeps only propose_issue replies", () => {
    const fixedReply = fixReply({ review_comment_id: 1, decision: "fixed" });
    const proposeReply = fixReply({
      review_comment_id: 2,
      decision: "propose_issue",
      issue_proposal: { title: "t", body: "b" },
    });
    expect(selectProposeIssueReplies([fixedReply, proposeReply])).toEqual([
      proposeReply,
    ]);
  });

  test("returns an empty array when there are no propose_issue replies", () => {
    expect(selectProposeIssueReplies([fixReply()])).toEqual([]);
  });
});

describe("matchReviewThreadForComment", () => {
  test("finds a thread whose first comment id matches", () => {
    const threads = [
      thread({
        id: "PRRT_1",
        firstCommentDatabaseId: 101,
        allCommentIds: [101],
      }),
    ];
    expect(matchReviewThreadForComment(threads, 101)).toBe("PRRT_1");
  });

  test("finds a thread by a later comment's id, not just the first", () => {
    const threads = [
      thread({
        id: "PRRT_1",
        firstCommentDatabaseId: 101,
        allCommentIds: [101, 202],
      }),
    ];
    expect(matchReviewThreadForComment(threads, 202)).toBe("PRRT_1");
  });

  test("returns null when no thread contains the id", () => {
    const threads = [
      thread({
        id: "PRRT_1",
        firstCommentDatabaseId: 101,
        allCommentIds: [101],
      }),
    ];
    expect(matchReviewThreadForComment(threads, 999)).toBeNull();
  });

  test("returns null for an empty thread list (e.g. a plain issue comment)", () => {
    expect(matchReviewThreadForComment([], 101)).toBeNull();
  });
});

describe("buildIssueProposalReason", () => {
  test("renders the proposal count into the fixed Japanese reason text", () => {
    expect(buildIssueProposalReason(3)).toBe("Issue化の提案が3件あります");
  });
});

describe("buildIssueProposalBody", () => {
  test("removes half-width spaces between ASCII and Japanese in the body", () => {
    const body = buildIssueProposalBody(
      "`src/greet.ts` と `src/shout.ts` の両方",
      "https://example.test/pr/4",
      4,
    );
    expect(body.startsWith("`src/greet.ts`と`src/shout.ts`の両方")).toBe(true);
  });

  test("substitutes the {{pr_url}} placeholder with the PR's own URL", () => {
    const body = buildIssueProposalBody(
      "背景\n提案\n{{pr_url}}",
      "https://github.com/octo-owner/atelier-works/pull/1",
      1,
    );
    expect(body).toContain(
      "https://github.com/octo-owner/atelier-works/pull/1",
    );
  });

  test("appends the origin footer without a space between Issue/PR and Japanese", () => {
    const body = buildIssueProposalBody("背景", "https://example.com/pr/1", 42);
    expect(body).toContain("このIssueはPR #42のレビュー指摘から起票されました");
  });
});

describe("renderIssueProposalApprovedReply", () => {
  test("starts with the pr_fix role tag", () => {
    expect(renderIssueProposalApprovedReply(42)).toStartWith(
      "[pr_fix 自動返信]\n",
    );
  });

  test("names the created Issue number", () => {
    expect(renderIssueProposalApprovedReply(42)).toContain(
      "Issue #42を起票しました。",
    );
  });

  test("ends with the Issue number as the disposition", () => {
    const body = renderIssueProposalApprovedReply(42);
    expect(body.split("\n").at(-1)).toBe("対応: Issue #42");
  });
});

describe("renderIssueProposalRejectedReply", () => {
  test("starts with the pr_fix role tag", () => {
    expect(renderIssueProposalRejectedReply("scope外のため")).toStartWith(
      "[pr_fix 自動返信]\n",
    );
  });

  test("includes the human's reason, writing-style normalized", () => {
    const body = renderIssueProposalRejectedReply("scope 外のため");
    expect(body).toContain("理由: scope外のため");
  });

  test("ends with 見送り as the disposition", () => {
    const body = renderIssueProposalRejectedReply("scope外のため");
    expect(body.split("\n").at(-1)).toBe("対応: 見送り");
  });
});

describe("decidePostProposalStatus", () => {
  test("keeps the current status while a proposal is still pending", () => {
    expect(decidePostProposalStatus(1, true)).toEqual({ action: "keep" });
  });

  test("swaps to rereview_requested when a commit was pushed this round", () => {
    expect(decidePostProposalStatus(0, true)).toEqual({
      action: "swap",
      toStatus: "rereview_requested",
    });
  });

  test("swaps to reviewed when nothing was pushed this round", () => {
    expect(decidePostProposalStatus(0, false)).toEqual({
      action: "swap",
      toStatus: "reviewed",
    });
  });
});

describe("buildIssueProposalTitle", () => {
  test("removes half-width spaces between ASCII and Japanese", () => {
    expect(buildIssueProposalTitle("greet と shout の敬称処理を共通化")).toBe(
      "greetとshoutの敬称処理を共通化",
    );
  });
});

describe("buildAuditProposalBody", () => {
  test("appends the audit-report provenance line", () => {
    const body = buildAuditProposalBody("本文", "2026-09-22〜2026-09-28");
    expect(body).toBe(
      "本文\n\nこのIssueは監査レポート(2026-09-22〜2026-09-28)から起票されました",
    );
  });
});

describe("decidePostProposalTransition", () => {
  test("keeps the status while proposals are pending", () => {
    expect(decidePostProposalTransition("audit", 1, false)).toEqual({
      action: "keep",
    });
  });

  test("moves an audit from awaiting_approval to audited", () => {
    expect(decidePostProposalTransition("audit", 0, false)).toEqual({
      action: "swap",
      expectedFrom: "awaiting_approval",
      toStatus: "audited",
    });
  });

  test("moves a pr_fix from needs_human to rereview_requested when a commit was pushed", () => {
    expect(decidePostProposalTransition("pr_fix", 0, true)).toEqual({
      action: "swap",
      expectedFrom: "needs_human",
      toStatus: "rereview_requested",
    });
  });

  test("moves a pr_fix from needs_human to reviewed when nothing was pushed", () => {
    const transition = decidePostProposalTransition("pr_fix", 0, false);
    expect(transition.action === "swap" && transition.toStatus).toBe(
      "reviewed",
    );
  });
});
