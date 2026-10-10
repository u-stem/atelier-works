// `poll_prs.ts`がレビューと修正を起動する経路で使う、判断の純粋関数
// (`f/factory/lib/poll_support.ts`)のテスト。

import { describe, expect, test } from "bun:test";
import {
  decidePrActions,
  type LabelerPolicy,
  type PrCandidate,
} from "../../f/factory/lib/poll_support.ts";

const REVIEW_LABEL = "factory:review";
const FIX_LABEL = "factory:fix";
const POLICY: LabelerPolicy = { viewerLogin: "octo-owner", allowedLogins: [] };

function candidate(overrides: Partial<PrCandidate> = {}): PrCandidate {
  return {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 7,
    title: "Fix the thing",
    headSha: "aaaaaaa1111111111111111111111111111111",
    labels: [],
    reviewLabelerLogin: null,
    fixLabelerLogin: null,
    hasActiveReviewingItem: false,
    lastKnownHeadSha: null,
    previousFixRound: 0,
    maxReviewId: 0,
    ...overrides,
  };
}

describe("decidePrActions — review", () => {
  test("triggers a label-based review and asks to remove the label", () => {
    const [decision] = decidePrActions(
      [candidate({ labels: [REVIEW_LABEL], reviewLabelerLogin: "octo-owner" })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review).toEqual({
      kind: "trigger_review",
      reason: "label",
      removeLabel: true,
    });
  });

  test("triggers an assignment-based review when the head_sha is unprocessed", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review.kind).toBe("trigger_review");
  });

  test("does not trigger review when an item is already reviewing", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          hasActiveReviewingItem: true,
          lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review).toEqual({ kind: "none" });
  });

  test("does not trigger review when the head_sha was already processed", () => {
    const [decision] = decidePrActions(
      [candidate({ lastKnownHeadSha: candidate().headSha })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review).toEqual({ kind: "none" });
  });
});

describe("decidePrActions — fix", () => {
  test("triggers a label-based fix and asks to remove the label", () => {
    const [decision] = decidePrActions(
      [candidate({ labels: [FIX_LABEL], fixLabelerLogin: "octo-owner" })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({
      kind: "trigger_fix",
      removeLabel: true,
    });
  });

  // `pr_fix`はコメントでは起動しない。
  // PRにどんなコメントがあっても、修正サイクルを始める手段は`fix_label`だけである。
  test("does not trigger fix without the label, even with no other state", () => {
    const [decision] = decidePrActions(
      [candidate()],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "none" });
  });

  // レビュー済みのPR(`pr_review`の作業項目は終わっており、
  // `hasActiveReviewingItem`はfalse)に修正ラベルが付いたら、修正サイクルを起動する。
  // `decidePrActions`は「レビュー済み」を区別せず、
  // 同じ種別の作業項目が実行中かどうかだけを見る。
  // こうしたPRを再び見つけるのは入出力側(`lib/github.ts`)の役割で、
  // ここでは判断そのものが「レビュー中であること」を条件にしていないことを確かめる。
  test("triggers a label-based fix on a PR that already finished a review", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          hasActiveReviewingItem: false,
          labels: [FIX_LABEL],
          fixLabelerLogin: "octo-owner",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix.kind).toBe("trigger_fix");
  });
});

describe("decidePrActions — labeler check", () => {
  function reviewOf(overrides: Partial<PrCandidate>, policy = POLICY) {
    const [decision] = decidePrActions(
      [candidate({ labels: [REVIEW_LABEL], ...overrides })],
      REVIEW_LABEL,
      FIX_LABEL,
      policy,
    );
    return decision?.review;
  }

  function fixOf(overrides: Partial<PrCandidate>, policy = POLICY) {
    const [decision] = decidePrActions(
      [candidate({ labels: [FIX_LABEL], ...overrides })],
      REVIEW_LABEL,
      FIX_LABEL,
      policy,
    );
    return decision?.fix;
  }

  test("denies a review label that another user added", () => {
    expect(reviewOf({ reviewLabelerLogin: "mallory" })).toEqual({
      kind: "deny_labeler",
    });
  });

  test("denies a review label with no known labeler", () => {
    expect(reviewOf({ reviewLabelerLogin: null })).toEqual({
      kind: "deny_labeler",
    });
  });

  test("does not fall back to the assignment path for a denied review label", () => {
    const review = reviewOf({
      reviewLabelerLogin: "mallory",
      lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
    });
    expect(review).toEqual({ kind: "deny_labeler" });
  });

  test("allows a review label that a listed login added", () => {
    const review = reviewOf(
      { reviewLabelerLogin: "alice" },
      { ...POLICY, allowedLogins: ["alice"] },
    );
    expect(review?.kind).toBe("trigger_review");
  });

  test("denies every review label when the viewer is unknown", () => {
    const review = reviewOf(
      { reviewLabelerLogin: "octo-owner" },
      { viewerLogin: null, allowedLogins: [] },
    );
    expect(review).toEqual({ kind: "deny_labeler" });
  });

  test("denies a fix label that another user added", () => {
    expect(fixOf({ fixLabelerLogin: "mallory" })).toEqual({
      kind: "deny_labeler",
    });
  });

  test("denies a fix label with no known labeler", () => {
    expect(fixOf({ fixLabelerLogin: null })).toEqual({ kind: "deny_labeler" });
  });

  test("allows a fix label that a listed login added", () => {
    const fix = fixOf(
      { fixLabelerLogin: "alice" },
      { ...POLICY, allowedLogins: ["alice"] },
    );
    expect(fix?.kind).toBe("trigger_fix");
  });

  test("judges the fix label by its own labeler, not the review label's", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          labels: [REVIEW_LABEL, FIX_LABEL],
          reviewLabelerLogin: "octo-owner",
          fixLabelerLogin: "mallory",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "deny_labeler" });
  });
});
