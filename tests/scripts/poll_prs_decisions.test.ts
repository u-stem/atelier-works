// `poll_prs.ts`がレビューと修正を起動する経路で使う、判断の純粋関数
// (`f/factory/lib/poll_support.ts`)のテスト。

import { describe, expect, test } from "bun:test";
import {
  decidePrActions,
  type LabelerPolicy,
  labelerPolicyFor,
  type PrCandidate,
  recordLabelerCheckLimit,
} from "../../f/factory/lib/poll_support.ts";
import { hasLabel } from "../../f/factory/lib/types.ts";

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
    authorLogin: "octo-owner",
    headInBaseRepo: true,
    headRef: "feature",
    reviewLabelerLogin: null,
    fixLabelerLogin: null,
    hasActiveReviewingItem: false,
    hasActiveFixItem: false,
    activeFixItemId: null,
    lastKnownHeadSha: null,
    previousFixRound: 0,
    maxReviewId: 0,
    ...overrides,
  };
}

describe("decidePrActions — draw.io viewer pin update branches", () => {
  const bumpBranch = "factory/drawio-viewer-32.5.0";

  test("does not start a fix for a viewer pin update branch", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          headRef: bumpBranch,
          labels: [FIX_LABEL],
          fixLabelerLogin: "octo-owner",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "none" });
  });

  test("still starts a fix for another branch", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          headRef: "feature",
          labels: [FIX_LABEL],
          fixLabelerLogin: "octo-owner",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "trigger_fix", removeLabel: true });
  });

  test("still reviews a viewer pin update branch", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          headRef: bumpBranch,
          labels: [REVIEW_LABEL],
          reviewLabelerLogin: "octo-owner",
        }),
      ],
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

  test("keeps denying a fix label from someone who is not allowed", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          headRef: bumpBranch,
          labels: [FIX_LABEL],
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
  test("does not trigger a fix while a pr_fix is in progress for the pull request", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          hasActiveFixItem: true,
          activeFixItemId: 60,
          labels: [FIX_LABEL],
          fixLabelerLogin: "octo-owner",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "none" });
  });

  test("still starts a review while a pr_fix is in progress", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          hasActiveFixItem: true,
          activeFixItemId: 60,
          labels: [REVIEW_LABEL],
          reviewLabelerLogin: "octo-owner",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review.kind).toBe("trigger_review");
  });

  test("denies a fix label from a person who is not allowed even while a pr_fix is in progress", () => {
    const [decision] = decidePrActions(
      [
        candidate({
          hasActiveFixItem: true,
          activeFixItemId: 60,
          labels: [FIX_LABEL],
          fixLabelerLogin: "mallory",
        }),
      ],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "deny_labeler" });
  });

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

// dependabotのフローは、影響があると判断したPRに、Factoryのアカウント(viewer)で`fix_label`を付けて修正に回す。
// その経路が`pr_fix`の起動の判定を通ること、dependabotの作業項目がレビューの自動検出を起こさないことを確かめる。
describe("decidePrActions — dependabot pull requests", () => {
  const dependabotPr = (overrides: Partial<PrCandidate> = {}) =>
    candidate({
      authorLogin: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
      ...overrides,
    });

  test("starts a fix when the dependabot flow added the fix label with the viewer's account", () => {
    const [decision] = decidePrActions(
      [dependabotPr({ labels: [FIX_LABEL], fixLabelerLogin: "octo-owner" })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.fix).toEqual({ kind: "trigger_fix", removeLabel: true });
  });

  test("does not start a review by detection when the latest row is a dependabot row of an older head", () => {
    const [decision] = decidePrActions(
      [dependabotPr({ lastKnownHeadSha: "b".repeat(40) })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    expect(decision?.review).toEqual({ kind: "none" });
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

describe("decidePrActions — detection without a label", () => {
  const UNPROCESSED = {
    lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
  };

  function reviewOf(overrides: Partial<PrCandidate>, policy = POLICY) {
    const [decision] = decidePrActions(
      [candidate({ ...UNPROCESSED, ...overrides })],
      REVIEW_LABEL,
      FIX_LABEL,
      policy,
    );
    return decision?.review;
  }

  test("starts a review of an unprocessed commit of the viewer's PR", () => {
    expect(reviewOf({ authorLogin: "octo-owner" })?.kind).toBe(
      "trigger_review",
    );
  });

  test("starts a review of an unprocessed commit of a listed author's PR", () => {
    const review = reviewOf(
      { authorLogin: "alice" },
      { ...POLICY, allowedLogins: ["alice"] },
    );
    expect(review?.kind).toBe("trigger_review");
  });

  test("does not start a review of a PR whose author is not allowed", () => {
    expect(reviewOf({ authorLogin: "mallory" })).toEqual({ kind: "none" });
  });

  test("does not start a review of a PR whose author is unknown", () => {
    expect(reviewOf({ authorLogin: null })).toEqual({ kind: "none" });
  });

  test("does not start a review by detection when the fix label was denied", () => {
    const review = reviewOf({
      labels: [FIX_LABEL],
      fixLabelerLogin: "mallory",
    });
    expect(review).toEqual({ kind: "none" });
  });

  test("does not start a review by detection when the fix label has no known labeler", () => {
    const review = reviewOf({ labels: [FIX_LABEL], fixLabelerLogin: null });
    expect(review).toEqual({ kind: "none" });
  });

  test("still starts a review by detection when the fix label was allowed", () => {
    const review = reviewOf({
      labels: [FIX_LABEL],
      fixLabelerLogin: "octo-owner",
    });
    expect(review?.kind).toBe("trigger_review");
  });

  test("does not fall back to detection when the review label was denied", () => {
    const review = reviewOf({
      labels: [REVIEW_LABEL],
      reviewLabelerLogin: "mallory",
    });
    expect(review).toEqual({ kind: "deny_labeler" });
  });

  test("treats a label whose case differs from the config as present", () => {
    const review = reviewOf({
      labels: ["Factory:Fix"],
      fixLabelerLogin: "mallory",
    });
    expect(review).toEqual({ kind: "none" });
  });

  test("denies a review label whose case differs from the config", () => {
    const review = reviewOf({
      labels: ["FACTORY:REVIEW"],
      reviewLabelerLogin: "mallory",
    });
    expect(review).toEqual({ kind: "deny_labeler" });
  });

  test("reviews a third-party PR when the allowed account added the review label", () => {
    const review = reviewOf({
      authorLogin: "mallory",
      labels: [REVIEW_LABEL],
      reviewLabelerLogin: "octo-owner",
    });
    expect(review?.kind).toBe("trigger_review");
  });

  test("does not review a third-party PR's new commit without the label", () => {
    const review = reviewOf({
      authorLogin: "mallory",
      lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
    });
    expect(review).toEqual({ kind: "none" });
  });
});

describe("decidePrActions — head repository", () => {
  const UNPROCESSED = {
    lastKnownHeadSha: "bbbbbbb2222222222222222222222222222222",
  };

  function decisionOf(overrides: Partial<PrCandidate>) {
    const [decision] = decidePrActions(
      [candidate({ ...UNPROCESSED, ...overrides })],
      REVIEW_LABEL,
      FIX_LABEL,
      POLICY,
    );
    return decision;
  }

  test("denies a label-based review of a fork PR", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      labels: [REVIEW_LABEL],
      reviewLabelerLogin: "octo-owner",
    });
    expect(decision?.review).toEqual({ kind: "deny_fork_head" });
  });

  test("denies a detected review of an allowed author's fork PR", () => {
    const decision = decisionOf({ headInBaseRepo: false });
    expect(decision?.review).toEqual({ kind: "deny_fork_head" });
  });

  test("does not report a fork PR whose commit was already processed", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      lastKnownHeadSha: candidate().headSha,
    });
    expect(decision?.review).toEqual({ kind: "none" });
  });

  test("does not report a fork PR while a review is running", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      hasActiveReviewingItem: true,
    });
    expect(decision?.review).toEqual({ kind: "none" });
  });

  test("does not report a fork PR of an author who is not allowed", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      authorLogin: "mallory",
    });
    expect(decision?.review).toEqual({ kind: "none" });
  });

  test("reports the labeler denial first when the label is not allowed", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      labels: [REVIEW_LABEL],
      reviewLabelerLogin: "mallory",
    });
    expect(decision?.review).toEqual({ kind: "deny_labeler" });
  });

  test("leaves the fix decision to the preparation guard", () => {
    const decision = decisionOf({
      headInBaseRepo: false,
      labels: [FIX_LABEL],
      fixLabelerLogin: "octo-owner",
    });
    expect(decision?.fix.kind).toBe("trigger_fix");
  });
});

describe("hasLabel", () => {
  test("matches regardless of case", () => {
    expect(hasLabel(["Factory:Review"], "factory:review")).toBe(true);
  });

  test("does not match a different label", () => {
    expect(hasLabel(["factory:fix"], "factory:review")).toBe(false);
  });
});

describe("labelerPolicyFor", () => {
  test("takes the viewer login as given", () => {
    const policy = labelerPolicyFor("octo-owner", {
      allowed_labeler_logins: ["alice"],
    });
    expect(policy.viewerLogin).toBe("octo-owner");
  });

  test("takes allowed_labeler_logins as the allowed logins", () => {
    const policy = labelerPolicyFor("octo-owner", {
      allowed_labeler_logins: ["alice"],
    });
    expect(policy.allowedLogins).toEqual(["alice"]);
  });
});

describe("recordLabelerCheckLimit", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };

  async function recorded(label = "factory:review") {
    const records: { kind: string; message: string }[] = [];
    await recordLabelerCheckLimit(
      async (record) => {
        records.push(record);
      },
      TARGET,
      label,
    );
    return records;
  }

  test("records the kind that asks a person to act", async () => {
    expect((await recorded())[0]?.kind).toBe("labeler_check_limit");
  });

  test("names the target and the label and asks to remove the label", async () => {
    expect((await recorded())[0]?.message).toBe(
      "octo-owner/atelier-works#7: factory:reviewラベルの付与者を判定できないため、着手できません。ラベルを外し、許可された人が付け直してください",
    );
  });

  test("builds the same message on the next poll", async () => {
    const first = await recorded();
    const second = await recorded();
    expect(second[0]?.message).toBe(first[0]?.message);
  });
});
