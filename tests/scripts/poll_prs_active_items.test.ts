// `poll_prs`が、PRごとの稼働中の作業項目を引く索引のテスト。
// `pr_review`だけは、ownerとrepoを小文字にそろえたキーで引く。`pr_review`の行の綴りが書き手によって揺れるためである。
// `pr_fix`の引き方は、綴りを区別したままにする。

import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  activeItemsByPr,
  activeItemsForPr,
  activeReviewItemsByLowerPr,
} from "../../f/factory/poll_prs.ts";

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 1,
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: "octo-owner",
    repo: "widgets",
    issue_number: null,
    issue_url: null,
    pr_number: 7,
    title: "t",
    body: null,
    status: "reviewing",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    profile: "standard",
    created_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

const FOUND = { owner: "Octo-Owner", repo: "Widgets", number: 7 };

describe("activeReviewItemsByLowerPr", () => {
  test("keys a pr_review by the lower-cased owner and repo", () => {
    const map = activeReviewItemsByLowerPr([
      item({ owner: "Octo-Owner", repo: "Widgets" }),
    ]);
    expect([...map.keys()]).toEqual(["octo-owner/widgets#7"]);
  });

  test("leaves out the rows that are not pr_review", () => {
    const map = activeReviewItemsByLowerPr([item({ kind: "pr_fix" })]);
    expect(map.size).toBe(0);
  });

  test("leaves out a row without a pull request number", () => {
    const map = activeReviewItemsByLowerPr([item({ pr_number: null })]);
    expect(map.size).toBe(0);
  });
});

describe("activeItemsForPr", () => {
  test("finds a pr_review written with another spelling of the owner and repo", () => {
    const review = item({ id: 2, owner: "octo-owner", repo: "widgets" });
    const found = activeItemsForPr(
      activeItemsByPr([review]),
      activeReviewItemsByLowerPr([review]),
      FOUND,
    );
    expect(found.map((entry) => entry.id)).toEqual([2]);
  });

  test("does not find a pr_fix written with another spelling", () => {
    const fix = item({ id: 3, kind: "pr_fix", owner: "octo-owner" });
    const found = activeItemsForPr(
      activeItemsByPr([fix]),
      activeReviewItemsByLowerPr([fix]),
      FOUND,
    );
    expect(found).toEqual([]);
  });

  test("finds a pr_fix written with the same spelling", () => {
    const fix = item({
      id: 3,
      kind: "pr_fix",
      owner: "Octo-Owner",
      repo: "Widgets",
    });
    const found = activeItemsForPr(
      activeItemsByPr([fix]),
      activeReviewItemsByLowerPr([fix]),
      FOUND,
    );
    expect(found.map((entry) => entry.id)).toEqual([3]);
  });

  test("lists a pr_review with the same spelling once", () => {
    const review = item({ id: 2, owner: "Octo-Owner", repo: "Widgets" });
    const found = activeItemsForPr(
      activeItemsByPr([review]),
      activeReviewItemsByLowerPr([review]),
      FOUND,
    );
    expect(found.map((entry) => entry.id)).toEqual([2]);
  });

  test("does not find the rows of another pull request", () => {
    const review = item({ id: 2, pr_number: 8 });
    const found = activeItemsForPr(
      activeItemsByPr([review]),
      activeReviewItemsByLowerPr([review]),
      FOUND,
    );
    expect(found).toEqual([]);
  });
});
