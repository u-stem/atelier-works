// Pure decision logic tests for poll_prs.ts's review/fix trigger path
// (f/factory/lib/poll_support.ts) — spec-cycle2.md §3 M5, §7 item 1.

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

  // User decision (2026-09-26): pr_fix has no comment-based trigger — the
  // `fix_label` is the only way to start a fix cycle, regardless of any
  // comment on the PR.
  test("does not trigger fix without the label, even with no other state", () => {
    const [decision] = decidePrActions([candidate()], REVIEW_LABEL, FIX_LABEL);
    expect(decision?.fix).toEqual({ kind: "none" });
  });

  // team-lead: an already-reviewed PR (its pr_review work item finished
  // long ago, so hasActiveReviewingItem is false — decidePrActions has no
  // separate "reviewed" concept, only "is a same-kind item currently
  // active") getting the fix label must still trigger a fix cycle —
  // searchPrs's per-state-label queries (team-lead design, 2026-09-26) are
  // what make such a PR reachable again (an E2E gap fixed at the I/O layer,
  // lib/github.ts), this confirms the pure decision itself imposes no
  // additional "must still be under active review" requirement.
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
