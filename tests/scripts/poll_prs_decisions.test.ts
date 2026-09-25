// Pure decision logic tests for poll_prs.ts's review/fix trigger path
// (f/factory/lib/poll_support.ts) — spec-cycle2.md §3 M5, §7 item 1.

import { describe, expect, test } from "bun:test";
import {
  decidePrActions,
  isFactoryFixCommand,
  type PrCandidate,
} from "../../f/factory/lib/poll_support.ts";

const REVIEW_LABEL = "factory:review";
const FIX_LABEL = "factory:fix";

function candidate(overrides: Partial<PrCandidate> = {}): PrCandidate {
  return {
    owner: "u-stem",
    repo: "atelier-works",
    number: 7,
    title: "Fix the thing",
    headSha: "aaaaaaa1111111111111111111111111111111",
    labels: [],
    hasActiveReviewingItem: false,
    hasActiveFixingItem: false,
    lastKnownHeadSha: null,
    previousFixRound: 0,
    lastCommentId: 0,
    newFixCommands: [],
    maxReviewId: 0,
    maxCommentId: 0,
    ...overrides,
  };
}

describe("isFactoryFixCommand", () => {
  test("matches the exact command", () => {
    expect(isFactoryFixCommand("/factory fix")).toBe(true);
  });

  test("matches case-insensitively with surrounding whitespace", () => {
    expect(isFactoryFixCommand("  /Factory Fix  \n")).toBe(true);
  });

  test("does not match unrelated text", () => {
    expect(isFactoryFixCommand("please factory fix this later")).toBe(false);
  });
});

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
      reason: "label",
      removeLabel: true,
      triggerCommentId: null,
    });
  });

  test("triggers a comment-based fix using the first new /factory fix command", () => {
    const [decision] = decidePrActions(
      [candidate({ newFixCommands: [{ id: 42 }, { id: 43 }] })],
      REVIEW_LABEL,
      FIX_LABEL,
    );
    const fix = decision?.fix;
    expect(fix?.kind === "trigger_fix" ? fix.triggerCommentId : null).toBe(42);
  });

  test("does not trigger fix when an item is already fixing", () => {
    const [decision] = decidePrActions(
      [candidate({ hasActiveFixingItem: true, newFixCommands: [{ id: 42 }] })],
      REVIEW_LABEL,
      FIX_LABEL,
    );
    expect(decision?.fix).toEqual({ kind: "none" });
  });

  test("does not trigger fix when there is no label and no new command", () => {
    const [decision] = decidePrActions([candidate()], REVIEW_LABEL, FIX_LABEL);
    expect(decision?.fix).toEqual({ kind: "none" });
  });
});
