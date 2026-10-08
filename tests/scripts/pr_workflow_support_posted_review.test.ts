// `pr_workflow_support.ts`の`withReviewMarkers`と`findPostedReviewId`のテスト。
// `pr_review_post.ts`は、投稿の後に記録する前にステップが落ちても、
// 再実行で同じレビューをもう一度投稿しないよう、この2つで投稿済みのレビューを見つける。

import { describe, expect, test } from "bun:test";
import {
  hasMarker,
  isFactoryPost,
  withMarker,
} from "../../f/factory/lib/github.ts";
import {
  findPostedReviewId,
  type PostedReviewCandidate,
  withReviewMarkers,
} from "../../f/factory/steps/pr_workflow_support.ts";

const VIEWER = "factory-bot";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SUMMARY = "[pr_review 自動レビュー] @alice\n指摘はありません。LGTMです。";

function review(
  overrides: Partial<PostedReviewCandidate> = {},
): PostedReviewCandidate {
  return {
    id: 42,
    authorLogin: VIEWER,
    body: withReviewMarkers(SUMMARY, 7, SHA),
    ...overrides,
  };
}

describe("withReviewMarkers", () => {
  test("keeps the pr_review marker of the work item as the last line", () => {
    const body = withReviewMarkers(SUMMARY, 7, SHA);
    expect(hasMarker(body, "pr_review", 7)).toBe(true);
  });

  test("keeps the summary as the beginning of the body", () => {
    const body = withReviewMarkers(SUMMARY, 7, SHA);
    expect(body).toStartWith(`${SUMMARY}\n`);
  });

  // pr_fixの指摘の収集(`listPrReviews`)が除くのはpr_fixの返信だけで、
  // pr_reviewのレビューは対応すべきフィードバックとして残す。
  test("is not mistaken for a pr_fix reply", () => {
    const body = withReviewMarkers(SUMMARY, 7, SHA);
    expect(isFactoryPost(VIEWER, VIEWER, body, "pr_fix")).toBe(false);
  });

  // shaがすべて数字でも、Factoryの目印として読まれないこと。
  test("does not add a line that reads as a factory marker", () => {
    const body = withReviewMarkers("summary", 7, "1234567");
    const markerLines = body
      .split("\n")
      .filter((line) => line.startsWith("<!-- factory:"));
    expect(markerLines).toEqual(["<!-- factory:pr_review:7 -->"]);
  });
});

describe("findPostedReviewId", () => {
  test("returns the id of the viewer's review for the same work item and sha", () => {
    expect(findPostedReviewId([review()], VIEWER, 7, SHA)).toBe(42);
  });

  test("matches the viewer login case-insensitively", () => {
    const reviews = [review({ authorLogin: "Factory-Bot" })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
  });

  test("returns null when the review is for another sha", () => {
    const reviews = [
      review({ body: withReviewMarkers(SUMMARY, 7, OTHER_SHA) }),
    ];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
  });

  test("returns null when the review is for another work item", () => {
    const reviews = [review({ body: withReviewMarkers(SUMMARY, 8, SHA) })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
  });

  // 目印は誰でも本文に貼り付けられるので、投稿者が自分でなければ投稿済みとみなさない。
  test("returns null when the review was written by someone else", () => {
    const reviews = [review({ authorLogin: "alice" })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
  });

  // shaの目印を持たないレビューは、どのshaに対するものか分からない。
  test("returns null for a review that carries no sha marker", () => {
    const reviews = [review({ body: withMarker("pr_review", 7, SUMMARY) })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
  });

  test("returns null when there are no reviews", () => {
    expect(findPostedReviewId([], VIEWER, 7, SHA)).toBeNull();
  });

  // 本文の途中に貼り付けられたshaの目印は、投稿済みの証拠にならない。
  test("returns null when the sha marker is in the middle of the body", () => {
    const forged = withMarker(
      "pr_review",
      7,
      `${SUMMARY}\n\n<!-- factory-review-sha:${SHA} -->\n\nmore text`,
    );
    const reviews = [review({ body: forged })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
  });

  test("matches when the body ends with trailing whitespace", () => {
    const reviews = [
      review({ body: `${withReviewMarkers(SUMMARY, 7, SHA)}\n\n  ` }),
    ];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
  });

  test("matches a body whose line endings were converted to CRLF", () => {
    const crlf = withReviewMarkers(SUMMARY, 7, SHA).replace(/\n/g, "\r\n");
    const reviews = [review({ body: crlf })];
    expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
  });
});
