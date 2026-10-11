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
  describeExpiry,
  describeRow,
  effectiveChip,
  emptyStateTone,
  filterInboxItems,
  findInboxItem,
  type InboxItem,
  inboxSubtitle,
  itemId,
  missingSelectionMessage,
  selectionAfterFilter,
  selectionOf,
  sortInboxItems,
  unlistedCounts,
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

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

const A1: InboxItem = {
  type: "approval",
  approval: approval({ approval_request_id: 1 }),
};
const F7: InboxItem = { type: "failure", failure: failure() };
const N21: InboxItem = { type: "notice", notice: notice() };

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
      ).map((item) => [item.type, itemId(item)]),
    ).toEqual([["approval", 5]]);
  });

  test("wraps each notice as a notice item keyed by its notice id", () => {
    expect(
      buildInboxItems(
        summaryOf({ approvals: [], notices: [notice({ notice_id: 9 })] }),
      ).map((item) => [item.type, itemId(item)]),
    ).toEqual([["notice", 9]]);
  });

  test("lists approvals before notices", () => {
    expect(
      buildInboxItems(summaryOf({ notices: [notice()] })).map(
        (item) => item.type,
      ),
    ).toEqual(["approval", "notice"]);
  });

  test("does not list failures yet", () => {
    expect(
      buildInboxItems(summaryOf({ approvals: [], failures: [failure()] })).map(
        (item) => item.type,
      ),
    ).toEqual([]);
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
      approval: approval({ approval_request_id: 1 }),
    };
    const second: InboxItem = {
      type: "approval",
      approval: approval({ approval_request_id: 2 }),
    };
    expect(sortInboxItems([first, second]).map(itemId)).toEqual([2, 1]);
  });

  test("breaks ties between kinds in the fixed order", () => {
    const at = "2026-10-05T00:00:00.000Z";
    const a: InboxItem = {
      type: "approval",
      approval: approval({ requested_at: at }),
    };
    const f: InboxItem = {
      type: "failure",
      failure: failure({ updated_at: at }),
    };
    const n: InboxItem = {
      type: "notice",
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
  test("offers nothing for an empty list", () => {
    expect(visibleChips([])).toEqual([]);
  });

  test("offers nothing when only one kind is present", () => {
    expect(visibleChips([A1, A1])).toEqual([]);
  });

  test("offers all and each kind when two kinds are present", () => {
    expect(visibleChips([A1, N21]).map((chip) => chip.id)).toEqual([
      "all",
      "approval",
      "notice",
    ]);
  });

  test("does not offer a kind without items", () => {
    expect(visibleChips([F7, N21]).map((chip) => chip.id)).toEqual([
      "all",
      "failure",
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
    expect(describeRow(A1, NOW)).toEqual({
      key: "approval:1",
      title: "Add feature",
      kindLabel: "要件定義",
      statusLabel: null,
      subLabel: "作業項目 #10",
      iso: "2026-10-01T00:00:00.000Z",
      expiry: null,
    });
  });

  test("describes a failure row", () => {
    expect(describeRow(F7, NOW)).toEqual({
      key: "failure:7",
      title: "Fix bug",
      kindLabel: "失敗",
      statusLabel: "失敗",
      subLabel: "Issue・作業項目 #7",
      iso: "2026-10-02T00:00:00.000Z",
      expiry: null,
    });
  });

  test("describes a failure of a work item that needs a person", () => {
    expect(
      describeRow(
        {
          type: "failure",
          failure: failure({ work_item_id: 8, status: "needs_human" }),
        },
        NOW,
      ).statusLabel,
    ).toBe("人の対応待ち");
  });

  test("describes a notice row without leaking the code", () => {
    expect(describeRow(N21, NOW)).toEqual({
      key: "notice:21",
      title: "データベースの掃除の失敗",
      kindLabel: "通知",
      statusLabel: null,
      subLabel: null,
      iso: "2026-10-03T00:00:00.000Z",
      expiry: null,
    });
  });
});

describe("describeRow for a notice", () => {
  test("marks an info notice in the kind label", () => {
    expect(
      describeRow({ type: "notice", notice: notice({ severity: "info" }) }, NOW)
        .kindLabel,
    ).toBe("通知(情報)");
  });

  test("marks a resolved notice in the status label", () => {
    expect(
      describeRow({ type: "notice", notice: notice({ resolved: true }) }, NOW)
        .statusLabel,
    ).toBe("解決済み");
  });

  test("names the first target of the body in the sub label", () => {
    expect(
      describeRow(
        { type: "notice", notice: notice({ message: "o/r#12 (work item 3)" }) },
        NOW,
      ).subLabel,
    ).toBe("o/r#12");
  });
});

describe("unlistedCounts", () => {
  test("is empty when every count is listed", () => {
    expect(
      unlistedCounts({ approvals: 1, failures: 0, notices: 0 }, [A1]),
    ).toEqual([]);
  });

  test("reports approvals cut by the limit", () => {
    expect(
      unlistedCounts({ approvals: 250, failures: 0, notices: 0 }, [A1]),
    ).toEqual([{ type: "approval", label: "承認", count: 249 }]);
  });

  test("reports failures that the list does not show yet and notices cut by the limit", () => {
    expect(
      unlistedCounts({ approvals: 1, failures: 5, notices: 4 }, [A1]),
    ).toEqual([
      { type: "failure", label: "失敗", count: 5 },
      { type: "notice", label: "通知", count: 4 },
    ]);
  });

  test("lists approvals first, then failures, then notices", () => {
    expect(
      unlistedCounts({ approvals: 3, failures: 2, notices: 4 }, [A1]).map(
        (entry) => entry.type,
      ),
    ).toEqual(["approval", "failure", "notice"]);
  });

  test("subtracts the listed items of a kind", () => {
    expect(
      unlistedCounts({ approvals: 1, failures: 3, notices: 0 }, [A1, F7]).map(
        (entry) => entry.count,
      ),
    ).toEqual([2]);
  });

  test("never reports a negative number", () => {
    expect(
      unlistedCounts({ approvals: 0, failures: 0, notices: 0 }, [A1, F7]),
    ).toEqual([]);
  });
});

describe("inboxSubtitle", () => {
  test("counts the listed approvals", () => {
    expect(inboxSubtitle([A1, A1], [])).toBe("承認 2件");
  });

  test("lists each kind that has items", () => {
    expect(inboxSubtitle([A1, F7, F7, N21], [])).toBe(
      "承認 1件、失敗 2件、通知 1件",
    );
  });

  test("says everything is done when nothing is left anywhere", () => {
    expect(inboxSubtitle([], [])).toBe("すべて片付いています");
  });

  test("has no subtitle when only unlisted kinds remain", () => {
    expect(
      inboxSubtitle(
        [],
        [
          {
            type: "failure",
            label: "失敗",
            count: 5,
          },
        ],
      ),
    ).toBeNull();
  });
});

describe("emptyStateTone", () => {
  test("is clear when nothing is left anywhere", () => {
    expect(emptyStateTone([])).toBe("clear");
  });

  test("is pending when another kind still needs attention", () => {
    expect(emptyStateTone([{ type: "failure", label: "失敗", count: 2 }])).toBe(
      "pending",
    );
  });
});

describe("effectiveChip", () => {
  test("keeps all", () => {
    expect(effectiveChip([], "all")).toBe("all");
  });

  test("keeps a chip that still has items", () => {
    expect(effectiveChip([A1, F7], "failure")).toBe("failure");
  });

  test("falls back to all when the chosen kind has no items", () => {
    expect(effectiveChip([A1], "failure")).toBe("all");
  });

  test("falls back to all when the list is empty", () => {
    expect(effectiveChip([], "approval")).toBe("all");
  });
});

describe("missingSelectionMessage", () => {
  test("asks for a selection when nothing is selected", () => {
    expect(missingSelectionMessage(null)).toBe(
      "一覧から項目を選んでください。",
    );
  });

  test("says an approval may already be handled", () => {
    expect(missingSelectionMessage({ type: "approval", id: 3 })).toContain(
      "すでに処理された",
    );
  });

  test("says a failure list is not ready", () => {
    expect(missingSelectionMessage({ type: "failure", id: 3 })).toBe(
      "この種類の一覧は準備中です。",
    );
  });

  test("says a notice may already be resolved", () => {
    expect(missingSelectionMessage({ type: "notice", id: 3 })).toContain(
      "すでに解決された",
    );
  });
});

describe("itemId", () => {
  test("is the request id of an approval", () => {
    expect(itemId(A1)).toBe(1);
  });

  test("is the work item id of a failure", () => {
    expect(itemId(F7)).toBe(7);
  });

  test("is the notice id of a notice", () => {
    expect(itemId(N21)).toBe(21);
  });
});

describe("describeExpiry", () => {
  test("shows the time left for a pending approval", () => {
    expect(
      describeExpiry(approval({ expires_at: "2026-10-09T15:30:00.000Z" }), NOW),
    ).toEqual({ label: "残り3時間", expired: false, urgent: true });
  });

  test("shows expired once the time has passed", () => {
    expect(
      describeExpiry(approval({ expires_at: "2026-10-09T11:00:00.000Z" }), NOW),
    ).toEqual({ label: "期限切れ", expired: true, urgent: true });
  });

  test("is not urgent with a day or more left", () => {
    expect(
      describeExpiry(approval({ expires_at: "2026-10-10T12:00:00.000Z" }), NOW)
        ?.urgent,
    ).toBe(false);
  });

  test("is urgent just under a day left", () => {
    expect(
      describeExpiry(approval({ expires_at: "2026-10-10T11:59:00.000Z" }), NOW)
        ?.urgent,
    ).toBe(true);
  });

  test("shows nothing without an expiry", () => {
    expect(describeExpiry(approval({ expires_at: null }), NOW)).toBeNull();
  });

  test("shows nothing for an approval that is no longer pending", () => {
    expect(
      describeExpiry(
        approval({
          status: "approved",
          expires_at: "2026-10-09T15:30:00.000Z",
        }),
        NOW,
      ),
    ).toBeNull();
  });

  test("shows nothing for an unreadable expiry", () => {
    expect(describeExpiry(approval({ expires_at: "soon" }), NOW)).toBeNull();
  });
});

describe("describeRow expiry", () => {
  test("carries the expiry of a pending approval", () => {
    const item: InboxItem = {
      type: "approval",
      approval: approval({ expires_at: "2026-10-10T12:00:00.000Z" }),
    };
    expect(describeRow(item, NOW).expiry).toEqual({
      label: "残り1日",
      expired: false,
      urgent: false,
    });
  });
});
