import { describe, expect, test } from "bun:test";
import type {
  ConsoleSummary,
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import {
  buildInboxItems,
  chipCounts,
  describeApproval,
  describeRow,
  filterInboxItems,
  findInboxItem,
  type InboxItem,
  otherCountsNote,
  selectionAfterFilter,
  selectionOf,
  sortInboxItems,
  visibleChips,
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

function failure(overrides: Partial<SummaryFailure> = {}): SummaryFailure {
  return {
    work_item_id: 7,
    kind: "issue",
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: null,
    pr_number: null,
    title: "Fix bug",
    status: "failed",
    updated_at: "2026-10-02T00:00:00.000Z",
    status_note: null,
    status_changed_at: null,
    job_failure_id: null,
    flow_path: null,
    job_id: null,
    step: null,
    error: null,
    occurred_at: null,
    ...overrides,
  };
}

function notice(overrides: Partial<SummaryNotice> = {}): SummaryNotice {
  return {
    notice_id: 21,
    kind: "cleanup_db_failed",
    message: "disk full",
    resolved: false,
    created_at: "2026-10-03T00:00:00.000Z",
    severity: "action",
    resolvable: true,
    ...overrides,
  };
}

const A1: InboxItem = {
  type: "approval",
  id: 1,
  approval: approval({ approval_request_id: 1 }),
};
const F7: InboxItem = { type: "failure", id: 7, failure: failure() };
const N21: InboxItem = { type: "notice", id: 21, notice: notice() };

function summaryOf(overrides: Partial<ConsoleSummary> = {}): ConsoleSummary {
  return {
    counts: { approvals: 1, failures: 0, notices: 0 },
    approvals: [approval()],
    failures: [],
    notices: [],
    ...overrides,
  };
}

describe("buildInboxItems", () => {
  test("wraps each approval as an approval item keyed by its request id", () => {
    expect(
      buildInboxItems(
        summaryOf({ approvals: [approval({ approval_request_id: 5 })] }),
      ).map((item) => [item.type, item.id]),
    ).toEqual([["approval", 5]]);
  });

  test("does not list failures or notices yet", () => {
    expect(
      buildInboxItems(
        summaryOf({
          failures: [failure()],
          notices: [notice()],
        }),
      ).map((item) => item.type),
    ).toEqual(["approval"]);
  });
});

describe("selectionOf", () => {
  test("uses the type and id of the item", () => {
    expect(selectionOf(F7)).toEqual({ type: "failure", id: 7 });
  });
});

describe("sortInboxItems", () => {
  test("puts the newest item first across kinds", () => {
    expect(sortInboxItems([A1, N21, F7]).map((item) => item.type)).toEqual([
      "notice",
      "failure",
      "approval",
    ]);
  });

  test("breaks ties by the larger id within a kind", () => {
    const first: InboxItem = {
      type: "approval",
      id: 1,
      approval: approval({ approval_request_id: 1 }),
    };
    const second: InboxItem = {
      type: "approval",
      id: 2,
      approval: approval({ approval_request_id: 2 }),
    };
    expect(sortInboxItems([first, second]).map((item) => item.id)).toEqual([
      2, 1,
    ]);
  });

  test("breaks ties between kinds in the fixed order", () => {
    const at = "2026-10-05T00:00:00.000Z";
    const a: InboxItem = {
      type: "approval",
      id: 1,
      approval: approval({ requested_at: at }),
    };
    const f: InboxItem = {
      type: "failure",
      id: 7,
      failure: failure({ updated_at: at }),
    };
    const n: InboxItem = {
      type: "notice",
      id: 21,
      notice: notice({ created_at: at }),
    };
    expect(sortInboxItems([n, f, a]).map((item) => item.type)).toEqual([
      "approval",
      "failure",
      "notice",
    ]);
  });

  test("does not mutate its input", () => {
    const input = [A1, N21];
    sortInboxItems(input);
    expect(input.map((item) => item.type)).toEqual(["approval", "notice"]);
  });
});

describe("filterInboxItems", () => {
  test("keeps everything for all", () => {
    expect(filterInboxItems([A1, F7, N21], "all")).toEqual([A1, F7, N21]);
  });

  test("keeps only one kind", () => {
    expect(filterInboxItems([A1, F7, N21], "failure")).toEqual([F7]);
  });
});

describe("chipCounts", () => {
  test("counts each kind and the total", () => {
    expect(chipCounts([A1, A1, F7, N21])).toEqual({
      all: 4,
      approval: 2,
      failure: 1,
      notice: 1,
    });
  });

  test("counts zero for an empty list", () => {
    expect(chipCounts([])).toEqual({
      all: 0,
      approval: 0,
      failure: 0,
      notice: 0,
    });
  });
});

describe("visibleChips", () => {
  test("always offers all and approval", () => {
    expect(visibleChips([]).map((chip) => chip.id)).toEqual([
      "all",
      "approval",
    ]);
  });

  test("adds a kind that has an item", () => {
    expect(visibleChips([A1, N21]).map((chip) => chip.id)).toEqual([
      "all",
      "approval",
      "notice",
    ]);
  });

  test("labels the chips by kind", () => {
    expect(visibleChips([A1, F7, N21]).map((chip) => chip.label)).toEqual([
      "すべて",
      "承認",
      "失敗",
      "通知",
    ]);
  });
});

describe("findInboxItem", () => {
  test("finds by type and id", () => {
    expect(findInboxItem([A1, F7], { type: "failure", id: 7 })).toBe(F7);
  });

  test("does not match the same id of another kind", () => {
    expect(findInboxItem([A1, F7], { type: "notice", id: 7 })).toBeNull();
  });

  test("returns null when nothing is selected", () => {
    expect(findInboxItem([A1], null)).toBeNull();
  });
});

describe("selectionAfterFilter", () => {
  test("keeps a selection that is still listed", () => {
    expect(selectionAfterFilter({ type: "failure", id: 7 }, "failure")).toEqual(
      { type: "failure", id: 7 },
    );
  });

  test("drops a selection that the chip hides", () => {
    expect(
      selectionAfterFilter({ type: "failure", id: 7 }, "approval"),
    ).toBeNull();
  });

  test("keeps a selection for all", () => {
    expect(selectionAfterFilter({ type: "approval", id: 1 }, "all")).toEqual({
      type: "approval",
      id: 1,
    });
  });

  test("keeps a selection whose kind the chip allows", () => {
    expect(
      selectionAfterFilter({ type: "approval", id: 99 }, "approval"),
    ).toEqual({ type: "approval", id: 99 });
  });

  test("returns null when nothing is selected", () => {
    expect(selectionAfterFilter(null, "approval")).toBeNull();
  });
});

describe("describeApproval", () => {
  test("uses the title of a requirements approval", () => {
    expect(describeApproval(approval()).title).toBe("Add feature");
  });

  test("uses the proposal title for an issue proposal", () => {
    expect(
      describeApproval(
        approval({
          kind: "issue_proposal",
          proposal_title: "Split the module",
        }),
      ).title,
    ).toBe("Split the module");
  });

  test("falls back to a work item reference when there is no title", () => {
    expect(
      describeApproval(approval({ title: null, work_item_id: 27 })).title,
    ).toBe("作業項目 #27");
  });

  test("labels the kind in Japanese", () => {
    expect(
      describeApproval(approval({ kind: "issue_proposal", origin: "audit" }))
        .kindLabel,
    ).toBe("改善提案");
  });

  test("labels an issue proposal from a PR fix", () => {
    expect(
      describeApproval(approval({ kind: "issue_proposal", origin: "pr_fix" }))
        .kindLabel,
    ).toBe("Issue化提案");
  });

  test("shows no status label for a pending approval", () => {
    expect(describeApproval(approval()).statusLabel).toBeNull();
  });

  test("labels an approved issue proposal as waiting for its issue", () => {
    expect(
      describeApproval(approval({ kind: "issue_proposal", status: "approved" }))
        .statusLabel,
    ).toBe("承認済み(Issue作成待ち)");
  });

  test("names the work item", () => {
    expect(describeApproval(approval()).workItemLabel).toBe("作業項目 #10");
  });

  test("adds the attempt for requirements", () => {
    expect(describeApproval(approval()).attemptLabel).toBe("試行 2");
  });

  test("has no attempt for an issue proposal", () => {
    expect(
      describeApproval(
        approval({ kind: "issue_proposal", draft_attempt: null }),
      ).attemptLabel,
    ).toBeNull();
  });

  test("names the issue", () => {
    expect(describeApproval(approval()).issueLabel).toBe("Issue #42");
  });

  test("passes a GitHub issue URL through", () => {
    expect(describeApproval(approval()).issueUrl).toBe(
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

describe("describeRow", () => {
  test("describes an approval row", () => {
    expect(describeRow(A1)).toEqual({
      key: "approval:1",
      title: "Add feature",
      kindLabel: "要件定義",
      statusLabel: null,
      subLabel: "作業項目 #10",
      iso: "2026-10-01T00:00:00.000Z",
    });
  });

  test("describes a failure row", () => {
    expect(describeRow(F7)).toEqual({
      key: "failure:7",
      title: "Fix bug",
      kindLabel: "失敗",
      statusLabel: "失敗",
      subLabel: "作業項目 #7",
      iso: "2026-10-02T00:00:00.000Z",
    });
  });

  test("describes a failure of a work item that needs a person", () => {
    expect(
      describeRow({
        type: "failure",
        id: 8,
        failure: failure({ work_item_id: 8, status: "needs_human" }),
      }).statusLabel,
    ).toBe("人の対応待ち");
  });

  test("describes a notice row without leaking the code", () => {
    expect(describeRow(N21)).toEqual({
      key: "notice:21",
      title: "データベースの掃除の失敗",
      kindLabel: "通知",
      statusLabel: null,
      subLabel: null,
      iso: "2026-10-03T00:00:00.000Z",
    });
  });
});

describe("otherCountsNote", () => {
  test("is empty when every count is listed", () => {
    expect(
      otherCountsNote({ approvals: 1, failures: 0, notices: 0 }, [A1]),
    ).toBeNull();
  });

  test("reports approvals cut by the limit", () => {
    expect(
      otherCountsNote({ approvals: 250, failures: 0, notices: 0 }, [A1]),
    ).toBe("ほかに、承認が249件あります。");
  });

  test("reports failures and notices that are not listed", () => {
    expect(
      otherCountsNote({ approvals: 1, failures: 2, notices: 1 }, [A1]),
    ).toBe("ほかに、失敗が2件、通知が1件あります。");
  });

  test("reports all three together", () => {
    expect(
      otherCountsNote({ approvals: 3, failures: 2, notices: 4 }, [A1]),
    ).toBe("ほかに、承認が2件、失敗が2件、通知が4件あります。");
  });

  test("subtracts the listed items of a kind", () => {
    expect(
      otherCountsNote({ approvals: 1, failures: 3, notices: 0 }, [A1, F7]),
    ).toBe("ほかに、失敗が2件あります。");
  });

  test("never reports a negative number", () => {
    expect(
      otherCountsNote({ approvals: 0, failures: 0, notices: 0 }, [A1, F7]),
    ).toBeNull();
  });
});
