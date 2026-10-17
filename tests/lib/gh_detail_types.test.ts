// 収集の詳細として保存する値の述語と、書き込みの検査のテスト。

import { describe, expect, test } from "bun:test";
import {
  checkGhIssueWrite,
  checkGhPullRequestWrite,
  checkGhRepoDetailWrite,
  type GhIssueWrite,
  type GhPullRequestWrite,
  type GhRepoDetailWrite,
  isGhAuthorType,
  isGhCollectStage,
  isGhIssueState,
  isGhMergeable,
  isGhPrState,
  isGitHubDatabaseId,
  isGitHubLogin,
  isGitSha,
  isStoredRefName,
} from "../../f/factory/lib/types.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CREATED = new Date("2026-10-17T01:00:00.000Z");
const UPDATED = new Date("2026-10-17T02:00:00.000Z");

function prRow(
  overrides: Partial<GhPullRequestWrite> = {},
): GhPullRequestWrite {
  return {
    number: 7,
    head_sha: SHA,
    head_ref: "factory/issue-1-wi-2",
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "dependabot",
    author_type: "Bot",
    author_id: 49699333,
    mergeable: "MERGEABLE",
    has_review_label: false,
    has_fix_label: false,
    review_requested_user_ids: [11],
    assignee_ids: [],
    team_review_requested: false,
    created_at: CREATED,
    updated_at: UPDATED,
    ...overrides,
  };
}

function issueRow(overrides: Partial<GhIssueWrite> = {}): GhIssueWrite {
  return {
    number: 3,
    author_login: "alice",
    author_type: "User",
    author_id: 1001,
    created_at: CREATED,
    updated_at: UPDATED,
    ...overrides,
  };
}

function detailWrite(
  overrides: Partial<GhRepoDetailWrite> = {},
): GhRepoDetailWrite {
  return {
    owner: "alice",
    repo: "widgets",
    repo_id: 2002,
    observed_at: CREATED,
    pr_rows: [prRow()],
    pr_keep: [7],
    issue_rows: [issueRow()],
    issue_keep: [3],
    ...overrides,
  };
}

describe("isGitSha", () => {
  test("accepts forty lowercase hex digits", () => {
    expect(isGitSha(SHA)).toBe(true);
  });

  test("rejects an abbreviated sha", () => {
    expect(isGitSha(SHA.slice(0, 39))).toBe(false);
  });

  test("rejects uppercase hex digits", () => {
    expect(isGitSha(SHA.toUpperCase())).toBe(false);
  });

  test("rejects a value with a trailing newline", () => {
    expect(isGitSha(`${SHA}\n`)).toBe(false);
  });
});

describe("isStoredRefName", () => {
  test("accepts an ordinary branch name", () => {
    expect(isStoredRefName("feature/a-b_c.d")).toBe(true);
  });

  test("accepts exactly 255 bytes", () => {
    expect(isStoredRefName("a".repeat(255))).toBe(true);
  });

  test("rejects 256 bytes", () => {
    expect(isStoredRefName("a".repeat(256))).toBe(false);
  });

  test("counts bytes, not characters", () => {
    expect(isStoredRefName("あ".repeat(86))).toBe(false);
  });

  test("rejects a right-to-left override", () => {
    expect(isStoredRefName("feature/‮evil")).toBe(false);
  });

  test("rejects a zero width space", () => {
    expect(isStoredRefName("feature/​evil")).toBe(false);
  });

  test("rejects the next line control character", () => {
    expect(isStoredRefName("feature/\u0085evil")).toBe(false);
  });

  test("rejects a line separator", () => {
    expect(isStoredRefName("feature/ evil")).toBe(false);
  });

  test("rejects an unpaired high surrogate", () => {
    expect(isStoredRefName("feature/\ud800evil")).toBe(false);
  });

  test("rejects an unpaired low surrogate", () => {
    expect(isStoredRefName("feature/\udc00evil")).toBe(false);
  });

  test("accepts a paired surrogate such as an emoji", () => {
    expect(isStoredRefName("feature/\ud83d\ude00")).toBe(true);
  });

  test("rejects a name the branch rules reject", () => {
    expect(isStoredRefName("a..b")).toBe(false);
  });

  test("rejects a non string", () => {
    expect(isStoredRefName(null)).toBe(false);
  });
});

describe("isGitHubLogin", () => {
  test("accepts a login of 39 characters", () => {
    expect(isGitHubLogin("a".repeat(39))).toBe(true);
  });

  test("rejects a login of 40 characters", () => {
    expect(isGitHubLogin("a".repeat(40))).toBe(false);
  });

  test("rejects a login that is not a GitHub name", () => {
    expect(isGitHubLogin("a b")).toBe(false);
  });
});

describe("isGitHubDatabaseId", () => {
  test("accepts a positive safe integer", () => {
    expect(isGitHubDatabaseId(49699333)).toBe(true);
  });

  test("rejects zero", () => {
    expect(isGitHubDatabaseId(0)).toBe(false);
  });

  test("rejects an integer above the safe range", () => {
    expect(isGitHubDatabaseId(2 ** 53)).toBe(false);
  });

  test("rejects a fraction", () => {
    expect(isGitHubDatabaseId(1.5)).toBe(false);
  });

  test("rejects a digit string", () => {
    expect(isGitHubDatabaseId("12")).toBe(false);
  });
});

describe("enumeration guards", () => {
  test("accepts the author type Bot", () => {
    expect(isGhAuthorType("Bot")).toBe(true);
  });

  test("rejects an unknown author type", () => {
    expect(isGhAuthorType("App")).toBe(false);
  });

  test("accepts the mergeable value CONFLICTING", () => {
    expect(isGhMergeable("CONFLICTING")).toBe(true);
  });

  test("rejects the mergeable value UNKNOWN", () => {
    expect(isGhMergeable("UNKNOWN")).toBe(false);
  });

  test("accepts the pull request state closed", () => {
    expect(isGhPrState("closed")).toBe(true);
  });

  test("rejects the issue state closed", () => {
    expect(isGhIssueState("closed")).toBe(false);
  });

  test("accepts the stage detail", () => {
    expect(isGhCollectStage("detail")).toBe(true);
  });

  test("rejects an unknown stage", () => {
    expect(isGhCollectStage("write")).toBe(false);
  });
});

describe("checkGhPullRequestWrite", () => {
  test("accepts a valid row", () => {
    expect(checkGhPullRequestWrite(prRow())).toBeNull();
  });

  test("accepts a row whose nullable columns are all null", () => {
    expect(
      checkGhPullRequestWrite(
        prRow({
          head_ref: null,
          base_ref: null,
          auto_merge_enabled: null,
          author_login: null,
          author_type: null,
          author_id: null,
          mergeable: null,
          has_review_label: null,
          has_fix_label: null,
          review_requested_user_ids: null,
          assignee_ids: null,
          team_review_requested: null,
        }),
      ),
    ).toBeNull();
  });

  test("names head_sha when the sha is not forty hex digits", () => {
    expect(checkGhPullRequestWrite(prRow({ head_sha: "abc" }))).toBe(
      "head_sha",
    );
  });

  test("names head_ref when the branch name has a format character", () => {
    expect(checkGhPullRequestWrite(prRow({ head_ref: "a‮b" }))).toBe("head_ref");
  });

  test("names base_ref when the branch name is too long", () => {
    expect(checkGhPullRequestWrite(prRow({ base_ref: "a".repeat(256) }))).toBe(
      "base_ref",
    );
  });

  test("names author_login when it is longer than 39 characters", () => {
    expect(
      checkGhPullRequestWrite(prRow({ author_login: "a".repeat(40) })),
    ).toBe("author_login");
  });

  test("names author_type when the login is set and the type is not", () => {
    expect(checkGhPullRequestWrite(prRow({ author_type: null }))).toBe(
      "author_type",
    );
  });

  test("names author_login when the type is set and the login is not", () => {
    expect(checkGhPullRequestWrite(prRow({ author_login: null }))).toBe(
      "author_login",
    );
  });

  test("names author_id when it is not a safe integer", () => {
    expect(checkGhPullRequestWrite(prRow({ author_id: 2 ** 53 }))).toBe(
      "author_id",
    );
  });

  test("names review_requested_user_ids when an id is not positive", () => {
    expect(
      checkGhPullRequestWrite(prRow({ review_requested_user_ids: [0] })),
    ).toBe("review_requested_user_ids");
  });

  test("names assignee_ids when an id is a fraction", () => {
    expect(checkGhPullRequestWrite(prRow({ assignee_ids: [1.5] }))).toBe(
      "assignee_ids",
    );
  });

  test("names number when it is not positive", () => {
    expect(checkGhPullRequestWrite(prRow({ number: 0 }))).toBe("number");
  });

  test("names created_at when the date is invalid", () => {
    expect(checkGhPullRequestWrite(prRow({ created_at: new Date("x") }))).toBe(
      "created_at",
    );
  });

  test("never echoes the checked value", () => {
    const secret = "github_pat_SECRET‮";
    expect(checkGhPullRequestWrite(prRow({ head_ref: secret }))).not.toContain(
      "SECRET",
    );
  });
});

describe("checkGhIssueWrite", () => {
  test("accepts a valid row", () => {
    expect(checkGhIssueWrite(issueRow())).toBeNull();
  });

  test("names author_login when it is not a login", () => {
    expect(checkGhIssueWrite(issueRow({ author_login: "a b" }))).toBe(
      "author_login",
    );
  });

  test("names updated_at when the date is invalid", () => {
    expect(checkGhIssueWrite(issueRow({ updated_at: new Date("x") }))).toBe(
      "updated_at",
    );
  });
});

describe("checkGhRepoDetailWrite", () => {
  test("accepts a valid write", () => {
    expect(checkGhRepoDetailWrite(detailWrite())).toBeNull();
  });

  test("accepts a write whose keep lists are empty", () => {
    expect(
      checkGhRepoDetailWrite(
        detailWrite({
          pr_rows: [],
          pr_keep: [],
          issue_rows: [],
          issue_keep: [],
        }),
      ),
    ).toBeNull();
  });

  test("names the pull request column of an invalid row", () => {
    expect(
      checkGhRepoDetailWrite(
        detailWrite({ pr_rows: [prRow({ head_sha: "abc" })] }),
      ),
    ).toBe("pr_rows.head_sha");
  });

  test("names the issue column of an invalid row", () => {
    expect(
      checkGhRepoDetailWrite(
        detailWrite({ issue_rows: [issueRow({ author_login: "a b" })] }),
      ),
    ).toBe("issue_rows.author_login");
  });

  test("names pr_rows when two rows share a number", () => {
    expect(
      checkGhRepoDetailWrite(
        detailWrite({ pr_rows: [prRow(), prRow()], pr_keep: [7] }),
      ),
    ).toBe("pr_rows.number");
  });

  test("names pr_rows when a row is not in the keep list", () => {
    expect(checkGhRepoDetailWrite(detailWrite({ pr_keep: [8] }))).toBe(
      "pr_rows.not_kept",
    );
  });

  test("names issue_rows when a row is not in the keep list", () => {
    expect(checkGhRepoDetailWrite(detailWrite({ issue_keep: [] }))).toBe(
      "issue_rows.not_kept",
    );
  });

  test("names pr_keep when a number repeats", () => {
    expect(
      checkGhRepoDetailWrite(
        detailWrite({ pr_rows: [], pr_keep: [7, 7], issue_rows: [] }),
      ),
    ).toBe("pr_keep");
  });

  test("names issue_keep when a number is not positive", () => {
    expect(
      checkGhRepoDetailWrite(detailWrite({ issue_rows: [], issue_keep: [0] })),
    ).toBe("issue_keep");
  });

  test("names owner when it is not a GitHub name", () => {
    expect(checkGhRepoDetailWrite(detailWrite({ owner: "a b" }))).toBe("owner");
  });

  test("names repo_id when it is not a positive integer", () => {
    expect(checkGhRepoDetailWrite(detailWrite({ repo_id: 0 }))).toBe("repo_id");
  });

  test("names observed_at when the date is invalid", () => {
    expect(
      checkGhRepoDetailWrite(detailWrite({ observed_at: new Date("x") })),
    ).toBe("observed_at");
  });
});
