import { describe, expect, test } from "bun:test";
import type {
  ConsoleSummary,
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import {
  actionableCounts,
  auditFailureCount,
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
  omitsKindLabels,
  selectionAfterFilter,
  selectionOf,
  sortInboxItems,
  unlistedCounts,
  unlistedNote,
  unlistedPath,
  visibleChips,
} from "./inboxView.ts";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

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

function noticeItem(id: number, message: string, kind?: string): InboxItem {
  return {
    type: "notice",
    notice: notice({
      notice_id: id,
      message,
      ...(kind === undefined ? {} : { kind }),
    }),
  };
}

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

  test("wraps each failure as a failure item keyed by its work item id", () => {
    expect(
      buildInboxItems(
        summaryOf({ failures: [failure({ work_item_id: 9 })] }),
      ).map((item) => [item.type, itemId(item)]),
    ).toEqual([
      ["approval", 1],
      ["failure", 9],
    ]);
  });

  test("leaves out the failures of an audit, which cannot be retried", () => {
    expect(
      buildInboxItems(
        summaryOf({
          approvals: [],
          failures: [
            failure({ work_item_id: 9, kind: "audit" }),
            failure({ work_item_id: 10 }),
          ],
        }),
      ).map((item) => itemId(item)),
    ).toEqual([10]);
  });

  test("wraps each notice as a notice item keyed by its notice id", () => {
    expect(
      buildInboxItems(
        summaryOf({ approvals: [], notices: [notice({ notice_id: 9 })] }),
      ).map((item) => [item.type, itemId(item)]),
    ).toEqual([["notice", 9]]);
  });

  test("lists approvals, then failures, then notices", () => {
    expect(
      buildInboxItems(
        summaryOf({ failures: [failure()], notices: [notice()] }),
      ).map((item) => item.type),
    ).toEqual(["approval", "failure", "notice"]);
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
      subTitle: null,
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
      subTitle: null,
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

  test("replaces hidden characters in the title of a failure row", () => {
    expect(
      describeRow({ type: "failure", failure: failure({ title: "a‮b" }) }, NOW)
        .title,
    ).toBe("a�b");
  });

  test("describes a notice row without leaking the code", () => {
    expect(describeRow(N21, NOW)).toEqual({
      key: "notice:21",
      title: "データベースの掃除の失敗",
      kindLabel: "通知",
      statusLabel: null,
      subLabel: "disk full",
      subTitle: "disk full",
      iso: "2026-10-03T00:00:00.000Z",
      expiry: null,
    });
  });
});

describe("describeRow for a notice", () => {
  test("marks a resolved notice in the status label", () => {
    expect(
      describeRow({ type: "notice", notice: notice({ resolved: true }) }, NOW)
        .statusLabel,
    ).toBe("解決済み");
  });

  test("names the first target of the body in the sub label", () => {
    expect(
      describeRow(noticeItem(1, "o/r#12 (work item 3)"), NOW).subLabel,
    ).toBe("o/r#12・(work item 3)");
  });

  test("names the first version of the body in the sub label", () => {
    expect(describeRow(noticeItem(1, `deployed(${SHA_A})`), NOW).subLabel).toBe(
      "版 0123456・deployed()",
    );
  });

  test("puts the target before the version and drops only the first target from the excerpt", () => {
    expect(
      describeRow(noticeItem(1, `${SHA_A} for o/r#12 and p/q#3`), NOW).subLabel,
    ).toBe("o/r#12・版 0123456・for and p/q#3");
  });

  test("cuts a long body to one line with an ellipsis", () => {
    expect(describeRow(noticeItem(1, "a".repeat(60)), NOW).subLabel).toBe(
      `${"a".repeat(36)}…`,
    );
  });

  test("joins the lines of the body into one", () => {
    expect(describeRow(noticeItem(1, "first\n  second"), NOW).subLabel).toBe(
      "first second",
    );
  });

  test("carries the whole body in the sub title", () => {
    expect(describeRow(noticeItem(1, "a".repeat(60)), NOW).subTitle).toBe(
      "a".repeat(60),
    );
  });

  test("keeps the whole body, with shortened versions, in the sub title", () => {
    expect(describeRow(noticeItem(1, `deployed(${SHA_A})`), NOW).subTitle).toBe(
      "deployed(0123456)",
    );
  });

  test("has no sub label for an empty body", () => {
    expect(describeRow(noticeItem(1, ""), NOW).subLabel).toBeNull();
  });
});

describe("describeRow for notices of one kind", () => {
  const mismatchBase = `f/factory/deployed_sha(${SHA_A})から、self cloneのHEADへの反映が進んでいません`;
  const failedHint = `${mismatchBase}。原因の候補: self_updateの反映が、今のself cloneのHEADで失敗しています`;
  const stalledHint = `${mismatchBase}。原因の候補: self_updateのスケジュールが止まっているか、今のself cloneのHEADをまだ試していません`;

  function subLabelsOf(messages: readonly string[]): (string | null)[] {
    const items = messages.map((message, index) =>
      noticeItem(index + 1, message, "schedule_failing"),
    );
    return items.map(
      (item) => describeRow(item, NOW, { peers: items }).subLabel,
    );
  }

  test("tells apart bodies whose versions agree and whose causes differ", () => {
    const labels = subLabelsOf([failedHint, stalledHint]);
    expect(new Set(labels).size).toBe(2);
  });

  test("shows the part where the cause differs", () => {
    expect(subLabelsOf([failedHint, stalledHint])[0]).toContain("の反映が、");
  });

  test("starts the excerpt after a path separator before where the bodies differ", () => {
    const head = "the scheduled run has failed several times in a row for";
    expect(
      subLabelsOf([
        `${head} f/factory/poll_issues since 10:00`,
        `${head} f/factory/cleanup_db since 10:00`,
      ]),
    ).toEqual(["…poll_issues since 10:00", "…cleanup_db since 10:00"]);
  });

  test("leaves out the target and the version that every notice shares", () => {
    expect(
      subLabelsOf([
        `o/r#1 ${SHA_A} failed at 10:00`,
        `o/r#1 ${SHA_A} failed at 11:00`,
      ]),
    ).toEqual(["…at 10:00", "…at 11:00"]);
  });

  test("keeps the target when the targets differ", () => {
    expect(subLabelsOf(["o/r#1 failed", "o/r#2 failed"])).toEqual([
      "o/r#1・failed",
      "o/r#2・failed",
    ]);
  });

  test("keeps the version when the versions differ", () => {
    expect(subLabelsOf([`v ${SHA_A}`, `v ${SHA_B}`])).toEqual([
      "版 0123456・v",
      "版 fedcba9・v",
    ]);
  });

  test("shows the target of every notice when only some of them share it", () => {
    expect(
      subLabelsOf(["o/r#1 failed", "o/r#1 failed again", "o/r#2 failed"]),
    ).toEqual(["o/r#1・failed", "o/r#1・failed again", "o/r#2・failed"]);
  });

  test("shows the version only on the notice that has one", () => {
    expect(subLabelsOf([`v ${SHA_A}`, "v none"])).toEqual([
      "版 0123456・v",
      "v none",
    ]);
  });

  test("starts the excerpt at a word boundary before the difference", () => {
    expect(
      subLabelsOf([
        "check item 12): requested review",
        "check item 12): requested revert",
      ]),
    ).toEqual(["…review", "…revert"]);
  });

  test("starts at the word that holds the difference", () => {
    expect(
      subLabelsOf([
        "check item 12): requested review of the change",
        "check item 12): requested changes to the change",
      ]),
    ).toEqual(["…review of the change", "…changes to the change"]);
  });

  test("keeps the plain lead when no boundary falls inside it", () => {
    expect(subLabelsOf([`${"a".repeat(20)}1`, `${"a".repeat(20)}2`])).toEqual([
      `…${"a".repeat(8)}1`,
      `…${"a".repeat(8)}2`,
    ]);
  });

  test("tells apart bodies that share the first target and differ in the second", () => {
    const labels = subLabelsOf([
      "o/r#1 and p/q#2 failed",
      "o/r#1 and p/q#3 failed",
    ]);
    expect(labels).toEqual(["…p/q#2 failed", "…p/q#3 failed"]);
  });

  test("cuts a target by its position, not by its text", () => {
    expect(describeRow(noticeItem(1, "o/r#1 then o/r#12"), NOW).subLabel).toBe(
      "o/r#1・then o/r#12",
    );
  });

  test("gives each notice the same excerpt whatever the order of the list", () => {
    const head = "x".repeat(40);
    const bodies = [`${head}a1`, `${head}a2`, `${head}b`];
    expect(subLabelsOf(bodies)).toEqual(
      [...subLabelsOf([...bodies].reverse())].reverse(),
    );
  });

  test("compares each notice with its nearest neighbor", () => {
    const head = "x".repeat(40);
    expect(subLabelsOf([`${head}a1`, `${head}a2`, `${head}b`])).toEqual([
      `…${"x".repeat(7)}a1`,
      `…${"x".repeat(7)}a2`,
      `…${"x".repeat(8)}b`,
    ]);
  });

  test("tells apart bodies when one is the start of the other", () => {
    const labels = subLabelsOf([
      "schedule f/factory/a keeps failing",
      "schedule f/factory/a keeps failing since 10:00",
    ]);
    expect(new Set(labels).size).toBe(2);
  });

  test("gives every notice a sub label even without a version or a target", () => {
    expect(subLabelsOf(["disk full", "network down"])).toEqual([
      "disk full",
      "network down",
    ]);
  });

  test("does not compare notices of different kinds", () => {
    const body = "shared body that is longer than the excerpt limit allows";
    const first = noticeItem(1, body, "schedule_failing");
    const other = noticeItem(2, `${body}!`, "cleanup_db_failed");
    expect(describeRow(first, NOW, { peers: [first, other] }).subLabel).toBe(
      "shared body that is longer than the…",
    );
  });
});

describe("describeRow without the kind", () => {
  test("drops the kind label of a notice", () => {
    expect(describeRow(N21, NOW, { showKind: false }).kindLabel).toBeNull();
  });

  test("drops the kind label of a failure", () => {
    expect(describeRow(F7, NOW, { showKind: false }).kindLabel).toBeNull();
  });

  test("keeps the kind label of an approval", () => {
    expect(describeRow(A1, NOW, { showKind: false }).kindLabel).toBe(
      "要件定義",
    );
  });
});

describe("omitsKindLabels", () => {
  test("is true when every item is a notice", () => {
    expect(omitsKindLabels([N21, noticeItem(22, "x")])).toBe(true);
  });

  test("is true when every item is a failure", () => {
    expect(omitsKindLabels([F7])).toBe(true);
  });

  test("is false when only approvals are listed", () => {
    expect(omitsKindLabels([A1])).toBe(false);
  });

  test("is false when the types differ", () => {
    expect(omitsKindLabels([A1, N21])).toBe(false);
  });

  test("is false for an empty list", () => {
    expect(omitsKindLabels([])).toBe(false);
  });
});

describe("unlistedPath", () => {
  test("points an audit failure to the system screen", () => {
    expect(
      unlistedPath({
        type: "failure",
        label: "監査の失敗",
        count: 3,
        cause: "audit",
      }),
    ).toBe("/system");
  });

  test("has no destination for notices over the limit", () => {
    expect(
      unlistedPath({ type: "notice", label: "通知", count: 2 }),
    ).toBeNull();
  });

  test("has no destination for failures over the limit", () => {
    expect(
      unlistedPath({ type: "failure", label: "失敗", count: 2 }),
    ).toBeNull();
  });

  test("has no destination for approvals over the limit", () => {
    expect(
      unlistedPath({ type: "approval", label: "承認", count: 2 }),
    ).toBeNull();
  });
});

describe("auditFailureCount", () => {
  test("counts the audit failures of the summary", () => {
    expect(
      auditFailureCount(
        summaryOf({
          failures: [
            failure({ work_item_id: 8, kind: "audit" }),
            failure({ work_item_id: 9, kind: "audit" }),
            failure({ work_item_id: 10 }),
          ],
        }),
      ),
    ).toBe(2);
  });
});

describe("actionableCounts", () => {
  test("leaves the audit failures out of the failure count", () => {
    expect(
      actionableCounts(
        summaryOf({
          counts: { approvals: 2, failures: 5, notices: 1 },
          failures: [failure({ kind: "audit" }), failure({ kind: "audit" })],
        }),
      ),
    ).toEqual({ approvals: 2, failures: 3, notices: 1 });
  });

  test("never goes below zero", () => {
    expect(
      actionableCounts(
        summaryOf({
          counts: { approvals: 0, failures: 0, notices: 0 },
          failures: [failure({ kind: "audit" })],
        }),
      ).failures,
    ).toBe(0);
  });
});

describe("unlistedNote", () => {
  test("says the approvals beyond the limit are not shown, oldest first", () => {
    expect(unlistedNote({ type: "approval", label: "承認", count: 1 })).toBe(
      "取得の上限を超えた分は、依頼の古いものから表示されません",
    );
  });

  test("says audit failures cannot be retried", () => {
    expect(
      unlistedNote({
        type: "failure",
        label: "監査の失敗",
        count: 1,
        cause: "audit",
      }),
    ).toBe("再実行できません。システムの画面で確認してください");
  });

  test("says the failures beyond the limit are not shown, oldest first", () => {
    expect(unlistedNote({ type: "failure", label: "失敗", count: 3 })).toBe(
      "取得の上限を超えた分は、更新の古いものから表示されません",
    );
  });
});

describe("unlistedNote for notices", () => {
  test("says the notices beyond the limit are not shown, oldest first", () => {
    expect(unlistedNote({ type: "notice", label: "通知", count: 3 })).toBe(
      "取得の上限を超えた分は、発生の古いものから表示されません",
    );
  });
});

describe("unlistedCounts with audit failures", () => {
  test("reports the audit failures as their own entry", () => {
    expect(
      unlistedCounts({ approvals: 1, failures: 2, notices: 0 }, [A1], 2),
    ).toEqual([
      { type: "failure", label: "監査の失敗", count: 2, cause: "audit" },
    ]);
  });

  test("keeps the audit failures out of the count of failures beyond the list", () => {
    expect(
      unlistedCounts(
        { approvals: 1, failures: 5, notices: 0 },
        [A1, F7],
        2,
      ).map((entry) => entry.count),
    ).toEqual([2, 2]);
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

  test("reports failures beyond the listed ones and notices cut by the limit", () => {
    expect(
      unlistedCounts({ approvals: 1, failures: 5, notices: 4 }, [A1, F7]),
    ).toEqual([
      { type: "failure", label: "失敗", count: 4 },
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

  test("says a failure may already be handled", () => {
    expect(missingSelectionMessage({ type: "failure", id: 3 })).toContain(
      "すでに処理された",
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
