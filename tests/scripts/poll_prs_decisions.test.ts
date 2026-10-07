// `poll_prs.ts`がレビューと修正を起動する経路で使う、判断の純粋関数
// (`f/factory/lib/poll_support.ts`)のテスト。

import { describe, expect, test } from "bun:test";
import {
  decidePrActions,
  type PrCandidate,
} from "../../f/factory/lib/poll_support.ts";

const REVIEW_LABEL = "factory:review";
const FIX_LABEL = "factory:fix";

function candidate(overrides: Partial<PrCandidate> = {}): PrCandidate {
  return {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 7,
    title: "Fix the thing",
    headSha: "aaaaaaa1111111111111111111111111111111",
    labels: [],
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
      [candidate({ labels: [REVIEW_LABEL] })],
      REVIEW_LABEL,
      FIX_LABEL,
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
    );
    expect(decision?.review).toEqual({ kind: "none" });
  });

  test("does not trigger review when the head_sha was already processed", () => {
    const [decision] = decidePrActions(
      [candidate({ lastKnownHeadSha: candidate().headSha })],
      REVIEW_LABEL,
      FIX_LABEL,
    );
    expect(decision?.review).toEqual({ kind: "none" });
  });
});

describe("decidePrActions — fix", () => {
  test("triggers a label-based fix and asks to remove the label", () => {
    const [decision] = decidePrActions(
      [candidate({ labels: [FIX_LABEL] })],
      REVIEW_LABEL,
      FIX_LABEL,
    );
    expect(decision?.fix).toEqual({
      kind: "trigger_fix",
      removeLabel: true,
    });
  });

  // `pr_fix`はコメントでは起動しない。
  // PRにどんなコメントがあっても、修正サイクルを始める手段は`fix_label`だけである。
  test("does not trigger fix without the label, even with no other state", () => {
    const [decision] = decidePrActions([candidate()], REVIEW_LABEL, FIX_LABEL);
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
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
    );
    expect(decision?.fix.kind).toBe("trigger_fix");
  });
});
