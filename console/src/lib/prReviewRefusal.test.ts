import { describe, expect, test } from "bun:test";
import {
  PR_REVIEW_REGISTER_REFUSAL_REASONS,
  PR_REVIEW_SUBMIT_REFUSAL_REASONS,
} from "../api/guards/writeResults.ts";
import {
  describePrReviewRegisterRefusal,
  describePrReviewSubmitRefusal,
} from "./prReviewRefusal.ts";

const NOT_STARTED = "フローは動きましたが、レビューは始まっていません。";

describe("the submit refusals", () => {
  test.each(PR_REVIEW_SUBMIT_REFUSAL_REASONS)(
    "words %s in Japanese",
    (reason) => {
      expect(describePrReviewSubmitRefusal(reason)).toMatch(/[぀-ヿ一-鿿]/);
    },
  );

  test.each(PR_REVIEW_SUBMIT_REFUSAL_REASONS)(
    "does not restate the heading of the notice in %s",
    (reason) => {
      expect(describePrReviewSubmitRefusal(reason)).not.toContain(
        "投入していません",
      );
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
      "このPRのレビューは進行中です。作業項目の一覧から確認してください。",
    );
  });

  test("words a repository that is not allowed as the one that was typed", () => {
    expect(describePrReviewSubmitRefusal("repo_not_allowed")).toBe(
      "このリポジトリは許可されていません。候補から選ぶか、許可の設定を確かめてください。",
    );
  });
});

describe("the register refusals", () => {
  const STARTED_NO_REVIEW = PR_REVIEW_REGISTER_REFUSAL_REASONS.filter(
    (reason) => reason !== "already_reviewing",
  );

  test.each(PR_REVIEW_REGISTER_REFUSAL_REASONS)(
    "words %s in Japanese",
    (reason) => {
      expect(describePrReviewRegisterRefusal(reason)).toMatch(/[぀-ヿ一-鿿]/);
    },
  );

  test.each(STARTED_NO_REVIEW)("says that %s started no review", (reason) => {
    expect(describePrReviewRegisterRefusal(reason).endsWith(NOT_STARTED)).toBe(
      true,
    );
  });

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

  test("says that an active review stays and no new one started, without contradiction", () => {
    expect(describePrReviewRegisterRefusal("already_reviewing")).toBe(
      "このPRのレビューは進行中です。新しいレビューは始めていません。作業項目の一覧から確認してください。",
    );
  });

  test("shares the sentence of an invalid number with the submit refusal", () => {
    expect(describePrReviewRegisterRefusal("invalid_pr_number")).toBe(
      `${describePrReviewSubmitRefusal("invalid_pr_number")}${NOT_STARTED}`,
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
