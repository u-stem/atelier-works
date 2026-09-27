// Tests for f/factory/steps/pr_workflow_support.ts's selectNewReviews,
// selectNewReviewComments, selectNewIssueComments, and decideCollectOutcome
// (used by pr_fix_collect.ts).

import { describe, expect, test } from "bun:test";
import {
  decideCollectOutcome,
  selectNewIssueComments,
  selectNewReviewComments,
  selectNewReviews,
} from "../../f/factory/steps/pr_workflow_support.ts";

const ALLOWED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

describe("selectNewReviews", () => {
  test("excludes reviews at or below the watermark", () => {
    const { items } = selectNewReviews(
      [
        {
          id: 5,
          authorLogin: "alice",
          authorAssociation: "OWNER",
          body: "please fix",
        },
      ],
      5,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });

  test("includes a review above the watermark with a non-empty body", () => {
    const { items } = selectNewReviews(
      [
        {
          id: 6,
          authorLogin: "alice",
          authorAssociation: "OWNER",
          body: "please fix",
        },
      ],
      5,
      ALLOWED,
    );
    expect(items).toEqual([{ id: 6, body: "please fix", author: "alice" }]);
  });

  test("excludes a review with an empty body", () => {
    const { items } = selectNewReviews(
      [
        {
          id: 6,
          authorLogin: "alice",
          authorAssociation: "OWNER",
          body: "   ",
        },
      ],
      5,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });

  test("excludes a review from an author_association outside the allowlist", () => {
    const { items } = selectNewReviews(
      [
        {
          id: 6,
          authorLogin: "mallory",
          authorAssociation: "NONE",
          body: "please fix",
        },
      ],
      5,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });

  test("reports the excluded author's login when association is disallowed", () => {
    const { excludedAuthors } = selectNewReviews(
      [
        {
          id: 6,
          authorLogin: "mallory",
          authorAssociation: "NONE",
          body: "please fix",
        },
      ],
      5,
      ALLOWED,
    );
    expect(excludedAuthors).toEqual(["mallory"]);
  });

  test("excludes a review with a null author_association", () => {
    const { items } = selectNewReviews(
      [
        {
          id: 6,
          authorLogin: "mallory",
          authorAssociation: null,
          body: "please fix",
        },
      ],
      5,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });
});

describe("selectNewReviewComments", () => {
  test("excludes comments at or below the watermark", () => {
    const { items } = selectNewReviewComments(
      [
        {
          id: 3,
          authorLogin: "bob",
          authorAssociation: "MEMBER",
          path: "a.ts",
          line: 1,
          body: "fix this",
        },
      ],
      3,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });

  test("maps a comment above the watermark", () => {
    const { items } = selectNewReviewComments(
      [
        {
          id: 4,
          authorLogin: "bob",
          authorAssociation: "MEMBER",
          path: "a.ts",
          line: 1,
          body: "fix this",
        },
      ],
      3,
      ALLOWED,
    );
    expect(items).toEqual([
      {
        id: 4,
        path: "a.ts",
        line: 1,
        body: "fix this",
        author: "bob",
      },
    ]);
  });

  test("excludes a comment from a disallowed author_association", () => {
    const { items } = selectNewReviewComments(
      [
        {
          id: 4,
          authorLogin: "mallory",
          authorAssociation: "CONTRIBUTOR",
          path: "a.ts",
          line: 1,
          body: "fix this",
        },
      ],
      3,
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });
});

describe("selectNewIssueComments", () => {
  // User decision (2026-09-26): pr_fix has no comment-based trigger of its
  // own (it starts only via the fix_label) — a comment written before the
  // label is added is plain feedback like any other human comment, verbatim,
  // even one that happens to look like the old `/factory fix` command.
  test("keeps a comment that looks like the old trigger command as plain feedback", () => {
    const { items } = selectNewIssueComments(
      [
        {
          id: 1,
          authorLogin: "carol",
          authorAssociation: "OWNER",
          body: "/factory fix\n\n空文字の敬称も直してください。",
        },
      ],
      ALLOWED,
    );
    expect(items[0]?.body).toBe(
      "/factory fix\n\n空文字の敬称も直してください。",
    );
  });

  test("maps a regular issue comment with an empty path/null line", () => {
    const { items } = selectNewIssueComments(
      [
        {
          id: 2,
          authorLogin: "carol",
          authorAssociation: "OWNER",
          body: "please also update the docs",
        },
      ],
      ALLOWED,
    );
    expect(items).toEqual([
      {
        id: 2,
        path: "",
        line: null,
        body: "please also update the docs",
        author: "carol",
      },
    ]);
  });

  test("excludes a comment from a disallowed author_association", () => {
    const { items } = selectNewIssueComments(
      [
        {
          id: 2,
          authorLogin: "mallory",
          authorAssociation: "FIRST_TIME_CONTRIBUTOR",
          body: "please also update the docs",
        },
      ],
      ALLOWED,
    );
    expect(items).toHaveLength(0);
  });

  test("reports the excluded author's login for a disallowed issue comment", () => {
    const { excludedAuthors } = selectNewIssueComments(
      [
        {
          id: 2,
          authorLogin: "mallory",
          authorAssociation: "FIRST_TIME_CONTRIBUTOR",
          body: "please also update the docs",
        },
      ],
      ALLOWED,
    );
    expect(excludedAuthors).toEqual(["mallory"]);
  });
});

describe("decideCollectOutcome", () => {
  test("proceeds when there is at least one new review", () => {
    const outcome = decideCollectOutcome(
      [{ id: 1, body: "x", author: "a" }],
      [],
    );
    expect(outcome).toBe("proceed");
  });

  test("proceeds when there is at least one new comment", () => {
    const outcome = decideCollectOutcome(
      [],
      [
        {
          id: 1,
          path: "a.ts",
          line: 1,
          body: "x",
          author: "a",
        },
      ],
    );
    expect(outcome).toBe("proceed");
  });

  test("reports no_feedback when there is nothing new", () => {
    const outcome = decideCollectOutcome([], []);
    expect(outcome).toBe("no_feedback");
  });
});
