// Tests for f/factory/steps/pr_workflow_support.ts's decideFixFinishAction,
// deriveFallbackReviewers, evaluateRerouteGuard, renderFixReply, and
// shouldAdvanceWatermarks (used by pr_fix_finish.ts).

import { describe, expect, test } from "bun:test";
import type { FixReply } from "../../f/factory/lib/types.ts";
import {
  decideFixFinishAction,
  deriveFallbackReviewers,
  evaluateRerouteGuard,
  renderFixReply,
  shouldAdvanceWatermarks,
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

describe("evaluateRerouteGuard", () => {
  test("allows the reroute when the parent work item has an issue_number", () => {
    expect(evaluateRerouteGuard(42)).toBeNull();
  });

  test("blocks the reroute when the parent work item has no issue_number", () => {
    expect(evaluateRerouteGuard(null)).toBe(
      "parent work item has no issue_number",
    );
  });
});

describe("shouldAdvanceWatermarks", () => {
  // team-lead fix (2026-09-26): watermarks used to advance unconditionally
  // before the outcome was known, so a later throw (e.g. `git commit`
  // failing) left processed watermarks past feedback that was never
  // actually consumed — a subsequent retry_work_item then found nothing to
  // collect. Only the two kinds below should advance the watermarks.
  test("advances watermarks when the requirements_gap reroute succeeded", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_reroute_success")).toBe(
      true,
    );
  });

  test("advances watermarks when the fix was pushed", () => {
    expect(shouldAdvanceWatermarks("push_success")).toBe(true);
  });

  test("does not advance watermarks when a guard blocked the attempt", () => {
    expect(shouldAdvanceWatermarks("guard_blocked")).toBe(false);
  });

  test("does not advance watermarks for a plain needs_human outcome", () => {
    expect(shouldAdvanceWatermarks("needs_human")).toBe(false);
  });

  test("does not advance watermarks when requirements_gap has no parent", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_needs_human")).toBe(false);
  });

  test("does not advance watermarks when the requirements_gap reroute failed", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_reroute_failed")).toBe(
      false,
    );
  });

  test("does not advance watermarks when the done outcome had no commit message", () => {
    expect(shouldAdvanceWatermarks("push_missing_commit_message")).toBe(false);
  });

  test("does not advance watermarks when the PR head moved before push", () => {
    expect(shouldAdvanceWatermarks("push_head_changed")).toBe(false);
  });

  test("does not advance watermarks when there was nothing to commit", () => {
    expect(shouldAdvanceWatermarks("push_nothing_to_commit")).toBe(false);
  });
});

function fixReply(overrides: Partial<FixReply> = {}): FixReply {
  return {
    review_comment_id: 1,
    body: "null チェックを追加しました",
    decision: "fixed",
    ...overrides,
  };
}

describe("renderFixReply", () => {
  // team-lead decision (2026-09-26): every factory post's first line names
  // the job that wrote it, since the factory posts under the operator's own
  // GitHub account.
  test("starts with the pr_fix role tag", () => {
    expect(renderFixReply(fixReply(), "abc1234ef")).toStartWith(
      "[pr_fix 自動返信]\n",
    );
  });

  // team-lead decision (2026-09-26): renderFixReply normalizes the body's
  // Japanese writing style (normalizeJapaneseText) — the half-width space
  // between the ASCII "null" and the following katakana is removed.
  test("includes the reply body, writing-style normalized", () => {
    expect(renderFixReply(fixReply(), "abc1234ef")).toContain(
      "nullチェックを追加しました",
    );
  });

  test("ends with the commit sha's short (7-char) form when fixed", () => {
    const body = renderFixReply(fixReply({ decision: "fixed" }), "abc1234ef");
    expect(body.split("\n").at(-1)).toBe("対応: `abc1234`");
  });

  test("ends with 見送り instead of a sha when skipped", () => {
    const body = renderFixReply(fixReply({ decision: "skipped" }), "abc1234ef");
    expect(body.split("\n").at(-1)).toBe("対応: 見送り");
  });

  // team-lead fix: nothing_to_commit still posts queued replies, with no
  // commit sha to point to.
  test("ends with 変更なし when fixed but there is no sha (nothing to commit)", () => {
    const body = renderFixReply(fixReply({ decision: "fixed" }), null);
    expect(body.split("\n").at(-1)).toBe("対応: 変更なし");
  });

  test("ends with 見送り instead of 変更なし when skipped and there is no sha", () => {
    const body = renderFixReply(fixReply({ decision: "skipped" }), null);
    expect(body.split("\n").at(-1)).toBe("対応: 見送り");
  });

  // User decision (2026-09-26): a finding that is valid but out of this
  // PR's scope gets a distinct rendering — the proposed Issue's title and a
  // preview of its body, ending with a dedicated disposition line instead
  // of a commit sha or 見送り.
  describe("propose_issue", () => {
    const proposeReply = fixReply({
      decision: "propose_issue",
      issue_proposal: {
        title: "共有ヘルパーへ抽出する",
        body: "背景\n提案\nhttps://github.com/octo-owner/atelier-works/pull/1",
      },
    });

    test("ends with the Issue化提案 disposition line", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body.split("\n").at(-1)).toBe("対応: Issue化を提案(承認待ち)");
    });

    test("includes the proposed Issue's title", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body).toContain("提案するIssue: 共有ヘルパーへ抽出する");
    });

    test("quotes the first 3 lines of the proposed Issue's body", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body).toContain(
        "> 背景\n> 提案\n> https://github.com/octo-owner/atelier-works/pull/1",
      );
    });

    test("does not quote a 4th body line", () => {
      const reply = fixReply({
        decision: "propose_issue",
        issue_proposal: { title: "t", body: "l1\nl2\nl3\nl4" },
      });
      expect(renderFixReply(reply, null)).not.toContain("> l4");
    });

    test("falls back to an empty title/body when issue_proposal is missing", () => {
      const reply = fixReply({
        decision: "propose_issue",
        issue_proposal: null,
      });
      expect(() => renderFixReply(reply, null)).not.toThrow();
    });
  });
});
