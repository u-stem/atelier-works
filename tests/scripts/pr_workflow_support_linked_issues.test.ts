// `pr_workflow_support.ts`の`extractLinkedIssueNumbers`のテスト。
// `poll_prs.ts`は、PR本文にあるGitHubのクローズキーワードでの参照を手がかりに、
// 人が作ったPRを承認済みの要件に結びつける。

import { describe, expect, test } from "bun:test";
import { extractLinkedIssueNumbers } from "../../f/factory/steps/pr_workflow_support.ts";

const OWNER = "acme";
const REPO = "widgets";

describe("extractLinkedIssueNumbers", () => {
  test("extracts a bare Closes #N reference", () => {
    expect(extractLinkedIssueNumbers("Closes #42", OWNER, REPO)).toEqual([42]);
  });

  test("extracts a bare Fixes #N reference", () => {
    expect(extractLinkedIssueNumbers("Fixes #7", OWNER, REPO)).toEqual([7]);
  });

  test("extracts a bare Resolves #N reference", () => {
    expect(extractLinkedIssueNumbers("Resolves #7", OWNER, REPO)).toEqual([7]);
  });

  test("matches every inflection of each keyword", () => {
    const inflections = [
      "close #1",
      "closes #1",
      "closed #1",
      "fix #1",
      "fixes #1",
      "fixed #1",
      "resolve #1",
      "resolves #1",
      "resolved #1",
    ];
    for (const body of inflections) {
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([1]);
    }
  });

  test("matches case-insensitively", () => {
    expect(extractLinkedIssueNumbers("CLOSED #9", OWNER, REPO)).toEqual([9]);
  });

  test("accepts a colon between the keyword and the reference", () => {
    expect(extractLinkedIssueNumbers("Fixes: #3", OWNER, REPO)).toEqual([3]);
  });

  test("dedupes a repeated reference to the same issue", () => {
    const body = "Closes #5\n\nAlso fixes #5.";
    expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([5]);
  });

  test("preserves first-occurrence order across distinct issues", () => {
    const body = "Fixes #9\nCloses #3";
    expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([9, 3]);
  });

  test("keeps an explicit owner/repo#N reference to this same repo", () => {
    const body = `Closes ${OWNER}/${REPO}#11`;
    expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([11]);
  });

  test("matches the owner/repo prefix case-insensitively", () => {
    const body = "Closes ACME/WIDGETS#11";
    expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([11]);
  });

  test("excludes an explicit owner/repo#N reference to a different repo", () => {
    const body = "Closes other-owner/other-repo#5";
    expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([]);
  });

  test("returns an empty array when the body has no closing keyword", () => {
    expect(
      extractLinkedIssueNumbers("See #5 for context.", OWNER, REPO),
    ).toEqual([]);
  });

  test("does not match 'close' inside a larger word (e.g. 'disclose')", () => {
    expect(extractLinkedIssueNumbers("discloses #5", OWNER, REPO)).toEqual([]);
  });
});
