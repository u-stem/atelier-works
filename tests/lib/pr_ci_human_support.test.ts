import { describe, expect, test } from "bun:test";
import type { PrCiCheck } from "../../f/factory/lib/db.ts";
import { labelerPolicyFor } from "../../f/factory/lib/poll_support.ts";
import {
  humanPrAuthors,
  humanPrCandidatesFromRows,
  isAllowedPrAuthor,
  isHumanPrCandidate,
  notifyPolicyFor,
  pullRequestKey,
} from "../../f/factory/lib/pr_ci_human_support.ts";
import {
  decideDeferredNotice,
  type PrCiNotifyPolicy,
} from "../../f/factory/lib/pr_ci_notify.ts";
import type { GhPullRequest } from "../../f/factory/lib/types.ts";

const POLICY = labelerPolicyFor("factory-bot", {
  allowed_labeler_logins: ["Alice", "bob"],
  allowed_labeler_ids: { bob: 22 },
});

function author(
  overrides: Partial<{
    login: string;
    id: number | null;
    type: string | null;
  }> = {},
) {
  return { login: "alice", id: 11, type: "User", ...overrides };
}

describe("isAllowedPrAuthor", () => {
  test("allows the account of the token", () => {
    expect(
      isAllowedPrAuthor(author({ login: "Factory-Bot", id: 1 }), POLICY),
    ).toBe(true);
  });

  test("allows a listed login that has no recorded id", () => {
    expect(
      isAllowedPrAuthor(author({ login: "alice", id: null }), POLICY),
    ).toBe(true);
  });

  test("allows a listed login whose id matches the recorded id", () => {
    expect(isAllowedPrAuthor(author({ login: "bob", id: 22 }), POLICY)).toBe(
      true,
    );
  });

  test("rejects a listed login whose id differs from the recorded id", () => {
    expect(isAllowedPrAuthor(author({ login: "bob", id: 99 }), POLICY)).toBe(
      false,
    );
  });

  test("rejects a login that is not listed", () => {
    expect(isAllowedPrAuthor(author({ login: "mallory" }), POLICY)).toBe(false);
  });

  test("rejects a bot even when the login is allowed", () => {
    expect(
      isAllowedPrAuthor(author({ login: "factory-bot", type: "Bot" }), POLICY),
    ).toBe(false);
  });

  test("rejects an author whose type is unknown", () => {
    expect(
      isAllowedPrAuthor(author({ login: "alice", type: null }), POLICY),
    ).toBe(false);
  });

  test("rejects every author when the account of the token is unknown", () => {
    const unknownViewer = labelerPolicyFor(null, {
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: {},
    });
    expect(isAllowedPrAuthor(author(), unknownViewer)).toBe(false);
  });
});

describe("humanPrAuthors", () => {
  test("lists the token account first and then the allowed logins", () => {
    expect(humanPrAuthors(POLICY)).toEqual(["factory-bot", "alice", "bob"]);
  });

  test("drops a duplicate that differs only in case", () => {
    const policy = labelerPolicyFor("Alice", {
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: {},
    });
    expect(humanPrAuthors(policy)).toEqual(["alice"]);
  });

  test("is empty when the account of the token is unknown", () => {
    const policy = labelerPolicyFor(null, {
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: {},
    });
    expect(humanPrAuthors(policy)).toEqual([]);
  });
});

describe("pullRequestKey", () => {
  test("lowercases the repository and keeps the number", () => {
    expect(pullRequestKey({ owner: "Acme", repo: "Widgets", number: 12 })).toBe(
      "acme/widgets#12",
    );
  });
});

const REF = { owner: "acme", repo: "widgets", number: 12 };

function candidate(
  overrides: Partial<{
    pr: Partial<{
      state: "open" | "closed";
      draft: boolean;
      headRef: string;
      headRepoFullName: string | null;
      baseRepoFullName: string;
    }>;
    tracked: string[];
  }> = {},
) {
  return {
    pr: {
      state: "open" as const,
      draft: false,
      headRef: "feature/x",
      headRepoFullName: "acme/widgets",
      baseRepoFullName: "acme/widgets",
      ...overrides.pr,
    },
    ref: REF,
    trackedPrKeys: new Set(overrides.tracked ?? []),
  };
}

describe("isHumanPrCandidate", () => {
  test("accepts an open pull request on a branch of the same repository", () => {
    expect(isHumanPrCandidate(candidate())).toBe(true);
  });

  test("rejects a closed pull request", () => {
    expect(isHumanPrCandidate(candidate({ pr: { state: "closed" } }))).toBe(
      false,
    );
  });

  test("rejects a draft pull request", () => {
    expect(isHumanPrCandidate(candidate({ pr: { draft: true } }))).toBe(false);
  });

  test("rejects a fork pull request", () => {
    expect(
      isHumanPrCandidate(
        candidate({ pr: { headRepoFullName: "mallory/widgets" } }),
      ),
    ).toBe(false);
  });

  test("rejects a pull request whose head repository is gone", () => {
    expect(
      isHumanPrCandidate(candidate({ pr: { headRepoFullName: null } })),
    ).toBe(false);
  });

  test("rejects a branch named like a factory implementation branch", () => {
    expect(
      isHumanPrCandidate(
        candidate({ pr: { headRef: "factory/issue-5-wi-33" } }),
      ),
    ).toBe(false);
  });

  test("accepts a branch that only starts like a factory branch", () => {
    expect(
      isHumanPrCandidate(
        candidate({ pr: { headRef: "factory/issue-5-wi-33-extra" } }),
      ),
    ).toBe(true);
  });

  test("accepts the branch of a viewer bump pull request", () => {
    expect(
      isHumanPrCandidate(
        candidate({ pr: { headRef: "factory/drawio-viewer-v1.2.3" } }),
      ),
    ).toBe(true);
  });

  test("rejects a pull request a tracked work item points at", () => {
    expect(
      isHumanPrCandidate(candidate({ tracked: ["acme/widgets#12"] })),
    ).toBe(false);
  });

  test("accepts a pull request when only another one is tracked", () => {
    expect(
      isHumanPrCandidate(candidate({ tracked: ["acme/widgets#13"] })),
    ).toBe(true);
  });

  test("matches the tracked url without regard to the case of the repository", () => {
    const input = candidate({ tracked: ["acme/widgets#12"] });
    expect(
      isHumanPrCandidate({
        ...input,
        ref: { owner: "Acme", repo: "Widgets", number: 12 },
      }),
    ).toBe(false);
  });
});

const POLICY_ON: PrCiNotifyPolicy = {
  fixEnabled: true,
  fixEnabledSince: new Date("2026-10-14T00:00:00Z"),
  claudeTimeoutSec: 1800,
};

function rowWith(workItemId: number | null): Pick<PrCiCheck, "work_item_id"> {
  return { work_item_id: workItemId };
}

describe("notifyPolicyFor", () => {
  test("turns the automatic fix off for a row of a human pull request", () => {
    expect(notifyPolicyFor(rowWith(null), POLICY_ON).fixEnabled).toBe(false);
  });

  test("keeps the other settings of the policy for a human row", () => {
    expect(notifyPolicyFor(rowWith(null), POLICY_ON).claudeTimeoutSec).toBe(
      1800,
    );
  });

  test("returns the policy as it is for a row of a factory pull request", () => {
    expect(notifyPolicyFor(rowWith(33), POLICY_ON)).toBe(POLICY_ON);
  });
});

describe("the notice of a failed human row", () => {
  const NOW = new Date("2026-10-14T12:00:00Z");
  const FRESH_ROW = {
    fixHoldReason: null,
    firstSeenAt: new Date(NOW.getTime() - 60 * 60_000),
    updatedAt: new Date(NOW.getTime() - 60_000),
  };

  test("is sent at once even when the automatic fix is enabled", () => {
    const decision = decideDeferredNotice({
      row: FRESH_ROW,
      policy: notifyPolicyFor(rowWith(null), POLICY_ON),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("waits for the automatic fix when the row belongs to a factory pull request", () => {
    const decision = decideDeferredNotice({
      row: FRESH_ROW,
      policy: notifyPolicyFor(rowWith(33), POLICY_ON),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "wait" });
  });
});

describe("humanPrCandidatesFromRows", () => {
  const AUTHORS = ["factory-bot", "alice"];

  function ghRow(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
    return {
      id: 1,
      owner: "acme",
      repo: "widgets",
      repo_id: 4242,
      number: 40,
      state: "open",
      head_sha: "a".repeat(40),
      head_ref: "feature/x",
      base_ref: "main",
      is_draft: false,
      is_cross_repository: false,
      auto_merge_enabled: false,
      author_login: "alice",
      author_type: "User",
      author_id: 11,
      mergeable: null,
      has_review_label: false,
      has_fix_label: false,
      review_requested_user_ids: [],
      assignee_ids: [],
      team_review_requested: false,
      created_at: new Date("2026-10-10T00:00:00.000Z"),
      updated_at: new Date("2026-10-11T00:00:00.000Z"),
      written_at: new Date("2026-10-11T00:00:00.000Z"),
      usable: true,
      ...overrides,
    };
  }

  test("does not select a draft row", () => {
    const rows = [ghRow({ is_draft: true })];
    expect(humanPrCandidatesFromRows(rows, AUTHORS)).toEqual([]);
  });

  test("does not select a row that is not open", () => {
    const rows = [ghRow({ state: "closed" })];
    expect(humanPrCandidatesFromRows(rows, AUTHORS)).toEqual([]);
  });

  test("does not select a row whose author is not in the list", () => {
    const rows = [ghRow({ author_login: "mallory" })];
    expect(humanPrCandidatesFromRows(rows, AUTHORS)).toEqual([]);
  });

  test("does not select a row whose author type is Bot", () => {
    const rows = [ghRow({ author_type: "Bot" })];
    expect(humanPrCandidatesFromRows(rows, AUTHORS)).toEqual([]);
  });

  test("selects a row without an author as a candidate whose author is unknown", () => {
    const rows = [ghRow({ author_login: null, author_type: null })];
    expect(humanPrCandidatesFromRows(rows, AUTHORS)).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        number: 40,
        updatedAtMs: Date.parse("2026-10-11T00:00:00.000Z"),
        authorUnknown: true,
      },
    ]);
  });

  test("selects a row with a login but without a type as a candidate whose author is unknown", () => {
    const rows = [ghRow({ author_login: "mallory", author_type: null })];
    expect(
      humanPrCandidatesFromRows(rows, AUTHORS).map(
        (found) => found.authorUnknown,
      ),
    ).toEqual([true]);
  });

  test("compares the login of the author without regard to case", () => {
    const rows = [ghRow({ author_login: "Alice" })];
    expect(
      humanPrCandidatesFromRows(rows, AUTHORS).map(
        (found) => found.authorUnknown,
      ),
    ).toEqual([false]);
  });

  test("turns the update time of the row into milliseconds", () => {
    const rows = [ghRow({ updated_at: new Date("2026-10-12T01:02:03.000Z") })];
    expect(
      humanPrCandidatesFromRows(rows, AUTHORS).map(
        (found) => found.updatedAtMs,
      ),
    ).toEqual([Date.parse("2026-10-12T01:02:03.000Z")]);
  });

  test("selects the row of a fork and the row of a factory-shaped branch like the search does", () => {
    const rows = [
      ghRow({ number: 41, is_cross_repository: true }),
      ghRow({ number: 42, head_ref: "factory/issue-7-wi-90" }),
    ];
    expect(
      humanPrCandidatesFromRows(rows, AUTHORS).map((found) => found.number),
    ).toEqual([41, 42]);
  });
});
