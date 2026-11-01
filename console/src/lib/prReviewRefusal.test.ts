import { describe, expect, test } from "bun:test";
import {
  PR_REVIEW_REGISTER_REFUSAL_REASONS,
  PR_REVIEW_SUBMIT_REFUSAL_REASONS,
} from "../api/guards/writeResults.ts";
import {
  describePrReviewRegisterRefusal,
  describePrReviewSubmitRefusal,
} from "./prReviewRefusal.ts";

const NOT_SUBMITTED = "投入していません。";
const NOT_STARTED = "フローは動きましたが、レビューは始まっていません。";

describe("the submit refusals", () => {
  test.each(PR_REVIEW_SUBMIT_REFUSAL_REASONS)(
    "words %s in Japanese",
    (reason) => {
      expect(describePrReviewSubmitRefusal(reason)).toMatch(/[぀-ヿ一-鿿]/);
    },
  );

  test.each(PR_REVIEW_SUBMIT_REFUSAL_REASONS)(
    "says that %s submitted nothing",
    (reason) => {
      expect(
        describePrReviewSubmitRefusal(reason).endsWith(NOT_SUBMITTED),
      ).toBe(true);
    },
  );

  test.each(PR_REVIEW_SUBMIT_REFUSAL_REASONS)(
    "does not repeat the code of %s",
    (reason) => {
      expect(describePrReviewSubmitRefusal(reason)).not.toContain(reason);
    },
  );

  test("has a distinct sentence for every reason", () => {
    expect(
      new Set(
        PR_REVIEW_SUBMIT_REFUSAL_REASONS.map(describePrReviewSubmitRefusal),
      ).size,
    ).toBe(PR_REVIEW_SUBMIT_REFUSAL_REASONS.length);
  });

  test("points an active review to the list of work items", () => {
    expect(describePrReviewSubmitRefusal("already_reviewing")).toBe(
      `このPRのレビューは進行中です。作業項目の一覧から確認してください。${NOT_SUBMITTED}`,
    );
  });

  test("words a repository that is not allowed as the one that was typed", () => {
    expect(describePrReviewSubmitRefusal("repo_not_allowed")).toBe(
      `このリポジトリは許可されていません。候補から選ぶか、許可の設定を確かめてください。${NOT_SUBMITTED}`,
    );
  });
});

describe("the register refusals", () => {
  test.each(PR_REVIEW_REGISTER_REFUSAL_REASONS)(
    "words %s in Japanese",
    (reason) => {
      expect(describePrReviewRegisterRefusal(reason)).toMatch(/[぀-ヿ一-鿿]/);
    },
  );

  test.each(PR_REVIEW_REGISTER_REFUSAL_REASONS)(
    "says that %s started no review",
    (reason) => {
      expect(
        describePrReviewRegisterRefusal(reason).endsWith(NOT_STARTED),
      ).toBe(true);
    },
  );

  test.each(PR_REVIEW_REGISTER_REFUSAL_REASONS)(
    "does not repeat the code of %s",
    (reason) => {
      expect(describePrReviewRegisterRefusal(reason)).not.toContain(reason);
    },
  );

  test("has a distinct sentence for every reason", () => {
    expect(
      new Set(
        PR_REVIEW_REGISTER_REFUSAL_REASONS.map(describePrReviewRegisterRefusal),
      ).size,
    ).toBe(PR_REVIEW_REGISTER_REFUSAL_REASONS.length);
  });

  test("words a repository that is not allowed as the renamed one", () => {
    expect(describePrReviewRegisterRefusal("repo_not_allowed")).toBe(
      `PRの正しいリポジトリ名(改名の後の名前)が許可されていません。${NOT_STARTED}`,
    );
  });

  test("shares the sentence of an active review with the submit refusal", () => {
    expect(
      describePrReviewRegisterRefusal("already_reviewing").startsWith(
        "このPRのレビューは進行中です。作業項目の一覧から確認してください。",
      ),
    ).toBe(true);
  });

  test("shares the sentence of an invalid number with the submit refusal", () => {
    const base = describePrReviewSubmitRefusal("invalid_pr_number").replace(
      NOT_SUBMITTED,
      "",
    );
    expect(describePrReviewRegisterRefusal("invalid_pr_number")).toBe(
      `${base}${NOT_STARTED}`,
    );
  });

  test("keeps the repository sentences of the two stages apart", () => {
    expect(describePrReviewRegisterRefusal("repo_not_allowed")).not.toContain(
      "このリポジトリは許可されていません",
    );
  });

  test.each(["fork_head", "owner_mismatch"] as const)(
    "does not mention the notice of %s",
    (reason) => {
      expect(describePrReviewRegisterRefusal(reason)).not.toContain("通知");
    },
  );
});
