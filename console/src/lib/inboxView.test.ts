import { describe, expect, test } from "bun:test";
import type { SummaryApproval } from "../api/guards/summary.ts";
import {
  chipCounts,
  chipOf,
  describeApproval,
  filterApprovals,
  findApproval,
  otherCountsNote,
  sortApprovals,
} from "./inboxView.ts";

function approval(overrides: Partial<SummaryApproval> = {}): SummaryApproval {
  return {
    approval_request_id: 1,
    kind: "requirements",
    status: "pending",
    work_item_id: 10,
    owner: "o",
    repo: "r",
    title: "Add feature",
    issue_number: 42,
    issue_url: "https://github.com/o/r/issues/42",
    pr_number: null,
    requested_at: "2026-10-01T00:00:00.000Z",
    expires_at: null,
    draft_attempt: 2,
    summary: null,
    proposal_title: null,
    created_issue_number: null,
    origin: null,
    ...overrides,
  };
}

const REQUIREMENTS = approval({ approval_request_id: 1 });
const PROPOSAL = approval({
  approval_request_id: 2,
  kind: "issue_proposal",
  origin: "pr_fix",
  proposal_title: "Split the module",
});
const IMPROVEMENT = approval({
  approval_request_id: 3,
  kind: "issue_proposal",
  origin: "audit",
  proposal_title: "Reduce cost",
});

describe("chipOf", () => {
  test("maps requirements", () => {
    expect(chipOf(REQUIREMENTS)).toBe("requirements");
  });

  test("maps an issue proposal from a PR fix", () => {
    expect(chipOf(PROPOSAL)).toBe("issue_proposal");
  });

  test("maps an issue proposal from an audit to improvement", () => {
    expect(chipOf(IMPROVEMENT)).toBe("improvement");
  });

  test("maps an issue proposal without an origin to issue_proposal", () => {
    expect(chipOf(approval({ kind: "issue_proposal", origin: null }))).toBe(
      "issue_proposal",
    );
  });
});

describe("filterApprovals", () => {
  const all = [REQUIREMENTS, PROPOSAL, IMPROVEMENT];

  test("keeps everything for all", () => {
    expect(filterApprovals(all, "all")).toEqual(all);
  });

  test("keeps only requirements", () => {
    expect(filterApprovals(all, "requirements")).toEqual([REQUIREMENTS]);
  });

  test("keeps only improvements", () => {
    expect(filterApprovals(all, "improvement")).toEqual([IMPROVEMENT]);
  });
});

describe("chipCounts", () => {
  test("counts each chip and the total", () => {
    expect(
      chipCounts([REQUIREMENTS, PROPOSAL, IMPROVEMENT, IMPROVEMENT]),
    ).toEqual({
      all: 4,
      requirements: 1,
      issue_proposal: 1,
      improvement: 2,
    });
  });

  test("counts zero for an empty list", () => {
    expect(chipCounts([])).toEqual({
      all: 0,
      requirements: 0,
      issue_proposal: 0,
      improvement: 0,
    });
  });
});

describe("sortApprovals", () => {
  test("puts the newest request first", () => {
    const older = approval({
      approval_request_id: 1,
      requested_at: "2026-10-01T00:00:00.000Z",
    });
    const newer = approval({
      approval_request_id: 2,
      requested_at: "2026-10-02T00:00:00.000Z",
    });
    expect(
      sortApprovals([older, newer]).map((item) => item.approval_request_id),
    ).toEqual([2, 1]);
  });

  test("breaks ties by the larger id", () => {
    const first = approval({ approval_request_id: 1 });
    const second = approval({ approval_request_id: 2 });
    expect(
      sortApprovals([first, second]).map((item) => item.approval_request_id),
    ).toEqual([2, 1]);
  });

  test("does not mutate its input", () => {
    const input = [
      approval({ approval_request_id: 1 }),
      approval({ approval_request_id: 2 }),
    ];
    sortApprovals(input);
    expect(input.map((item) => item.approval_request_id)).toEqual([1, 2]);
  });
});

describe("findApproval", () => {
  test("finds by id", () => {
    expect(findApproval([REQUIREMENTS, PROPOSAL], 2)).toBe(PROPOSAL);
  });

  test("returns null for an unknown id", () => {
    expect(findApproval([REQUIREMENTS], 99)).toBeNull();
  });

  test("returns null when nothing is selected", () => {
    expect(findApproval([REQUIREMENTS], null)).toBeNull();
  });
});

describe("describeApproval", () => {
  test("uses the title of a requirements approval", () => {
    expect(describeApproval(REQUIREMENTS).title).toBe("Add feature");
  });

  test("uses the proposal title for an issue proposal", () => {
    expect(describeApproval(PROPOSAL).title).toBe("Split the module");
  });

  test("falls back to a work item reference when there is no title", () => {
    expect(
      describeApproval(approval({ title: null, work_item_id: 27 })).title,
    ).toBe("作業項目 #27");
  });

  test("labels the kind in Japanese", () => {
    expect(describeApproval(IMPROVEMENT).kindLabel).toBe("改善提案");
  });

  test("names the work item", () => {
    expect(describeApproval(REQUIREMENTS).workItemLabel).toBe("作業項目 #10");
  });

  test("adds the attempt for requirements", () => {
    expect(describeApproval(REQUIREMENTS).attemptLabel).toBe("試行 2");
  });

  test("has no attempt for an issue proposal", () => {
    expect(
      describeApproval(
        approval({ kind: "issue_proposal", draft_attempt: null }),
      ).attemptLabel,
    ).toBeNull();
  });

  test("names the issue", () => {
    expect(describeApproval(REQUIREMENTS).issueLabel).toBe("Issue #42");
  });

  test("passes a GitHub issue URL through", () => {
    expect(describeApproval(REQUIREMENTS).issueUrl).toBe(
      "https://github.com/o/r/issues/42",
    );
  });

  test("drops an unsafe issue URL", () => {
    expect(
      describeApproval(approval({ issue_url: "javascript:alert(1)" })).issueUrl,
    ).toBeNull();
  });

  test("has no issue label without an issue number", () => {
    expect(
      describeApproval(approval({ issue_number: null, issue_url: null }))
        .issueLabel,
    ).toBeNull();
  });
});

describe("otherCountsNote", () => {
  test("is empty when there are no failures or notices", () => {
    expect(
      otherCountsNote({ approvals: 3, failures: 0, notices: 0 }),
    ).toBeNull();
  });

  test("mentions failures and notices", () => {
    expect(otherCountsNote({ approvals: 0, failures: 2, notices: 1 })).toBe(
      "ほかに、失敗が2件、通知が1件あります。",
    );
  });

  test("mentions only failures", () => {
    expect(otherCountsNote({ approvals: 0, failures: 2, notices: 0 })).toBe(
      "ほかに、失敗が2件あります。",
    );
  });

  test("mentions only notices", () => {
    expect(otherCountsNote({ approvals: 0, failures: 0, notices: 4 })).toBe(
      "ほかに、通知が4件あります。",
    );
  });
});
