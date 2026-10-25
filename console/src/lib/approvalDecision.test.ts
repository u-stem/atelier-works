import { describe, expect, test } from "bun:test";
import { MAX_REASON_LENGTH } from "../api/writes.ts";
import {
  approvalConfirmation,
  approvalLinks,
  approveGateProblem,
  decisionSurface,
  docReadiness,
  EXPIRED_MESSAGE,
  FULL_CHECK_MESSAGE,
  factoryLabelChoice,
  holdWhileLoadingShown,
  isDecidable,
  proposalOrigin,
  reasonCounter,
  redoConfirmation,
  rejectConfirmation,
  rejectProblem,
  requirementsBlockedReason,
  snapshotReadiness,
  waitingMessage,
  withFactoryLabelArg,
} from "./approvalDecision.ts";

const NOW = Date.parse("2026-10-11T00:00:00.000Z");

describe("isDecidable", () => {
  test("accepts a pending request without a deadline", () => {
    expect(isDecidable({ status: "pending", expires_at: null }, NOW)).toBe(
      true,
    );
  });

  test("accepts a pending request before its deadline", () => {
    expect(
      isDecidable(
        { status: "pending", expires_at: "2026-10-11T00:00:01.000Z" },
        NOW,
      ),
    ).toBe(true);
  });

  test("refuses a pending request at its deadline", () => {
    expect(
      isDecidable(
        { status: "pending", expires_at: "2026-10-11T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
  });

  test("refuses a pending request after its deadline", () => {
    expect(
      isDecidable(
        { status: "pending", expires_at: "2026-10-10T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
  });

  test("refuses an approved request", () => {
    expect(isDecidable({ status: "approved", expires_at: null }, NOW)).toBe(
      false,
    );
  });

  test("refuses a status it does not know", () => {
    expect(isDecidable({ status: "archived", expires_at: null }, NOW)).toBe(
      false,
    );
  });

  test("refuses a deadline it cannot read", () => {
    expect(isDecidable({ status: "pending", expires_at: "soon" }, NOW)).toBe(
      false,
    );
  });
});

describe("reasonCounter", () => {
  test("counts code points, not UTF-16 units", () => {
    expect(reasonCounter("a😀").count).toBe(2);
  });

  test("is not over at the limit", () => {
    expect(reasonCounter("a".repeat(MAX_REASON_LENGTH)).over).toBe(false);
  });

  test("is over one past the limit", () => {
    expect(reasonCounter("a".repeat(MAX_REASON_LENGTH + 1)).over).toBe(true);
  });

  test("shows the count against the limit", () => {
    expect(reasonCounter("abc").label).toBe(
      `3 / ${String(MAX_REASON_LENGTH)}文字`,
    );
  });
});

describe("rejectProblem", () => {
  test("asks for a reason when it is empty", () => {
    expect(rejectProblem("")).toBe("却下する理由を入力してください。");
  });

  test("asks for a reason when it is only whitespace", () => {
    expect(rejectProblem(" \n\t　")).toBe("却下する理由を入力してください。");
  });

  test("accepts a reason", () => {
    expect(rejectProblem("scope is too wide")).toBeNull();
  });

  test("refuses a reason over the limit", () => {
    expect(rejectProblem("a".repeat(MAX_REASON_LENGTH + 1))).toBe(
      `理由は${String(MAX_REASON_LENGTH)}文字までです。`,
    );
  });
});

describe("snapshotReadiness", () => {
  test("is loading while the snapshot is pending", () => {
    expect(
      snapshotReadiness({ isPending: true, isError: false, data: undefined }),
    ).toBe("loading");
  });

  test("is failed when the snapshot could not be read", () => {
    expect(
      snapshotReadiness({ isPending: false, isError: true, data: undefined }),
    ).toBe("failed");
  });

  test("is empty when the work item has no snapshot", () => {
    expect(
      snapshotReadiness({ isPending: false, isError: false, data: null }),
    ).toBe("empty");
  });

  test("is ready when the snapshot is read", () => {
    expect(
      snapshotReadiness({ isPending: false, isError: false, data: {} }),
    ).toBe("ready");
  });
});

describe("factoryLabelChoice", () => {
  test("offers the choice for a proposal from a pull request", () => {
    expect(
      factoryLabelChoice({ origin: "pr_fix", factory_label_available: false })
        .offered,
    ).toBe(true);
  });

  test("starts a proposal from a pull request without the label", () => {
    expect(
      factoryLabelChoice({ origin: "pr_fix", factory_label_available: false })
        .initial,
    ).toBe(false);
  });

  test("offers the choice for an audit proposal that can take the label", () => {
    expect(
      factoryLabelChoice({ origin: "audit", factory_label_available: true })
        .offered,
    ).toBe(true);
  });

  test("starts an audit proposal with the label", () => {
    expect(
      factoryLabelChoice({ origin: "audit", factory_label_available: true })
        .initial,
    ).toBe(true);
  });

  test("withholds the choice for an audit proposal that cannot take the label", () => {
    expect(
      factoryLabelChoice({ origin: "audit", factory_label_available: false })
        .offered,
    ).toBe(false);
  });
});

describe("withFactoryLabelArg", () => {
  test("sends the checked value for a proposal when the choice is offered", () => {
    expect(withFactoryLabelArg("issue_proposal", true, true)).toBe(true);
  });

  test("sends false for a proposal when the choice is withheld", () => {
    expect(withFactoryLabelArg("issue_proposal", false, true)).toBe(false);
  });

  test("sends nothing for requirements", () => {
    expect(withFactoryLabelArg("requirements", true, true)).toBeUndefined();
  });

  test("sends nothing for a kind it does not know", () => {
    expect(withFactoryLabelArg("other", true, true)).toBeUndefined();
  });
});

describe("approvalConfirmation", () => {
  test("names the subject and the request id", () => {
    const confirmation = approvalConfirmation({
      kind: "requirements",
      subject: "Add feature",
      approvalRequestId: 7,
      withFactoryLabel: undefined,
    });
    expect([confirmation.subject, confirmation.idLabel]).toEqual([
      "Add feature",
      "承認依頼 #7",
    ]);
  });

  test("warns that approving requirements starts the implementation", () => {
    const confirmation = approvalConfirmation({
      kind: "requirements",
      subject: "Add feature",
      approvalRequestId: 7,
      withFactoryLabel: undefined,
    });
    expect(confirmation.consequence).toContain("実装");
  });

  test("warns that approving a proposal creates an issue", () => {
    const confirmation = approvalConfirmation({
      kind: "issue_proposal",
      subject: "Fix flaky test",
      approvalRequestId: 8,
      withFactoryLabel: false,
    });
    expect(confirmation.consequence).toContain("Issue");
  });

  test("adds that the label starts the requirements flow when it is on", () => {
    const confirmation = approvalConfirmation({
      kind: "issue_proposal",
      subject: "Fix flaky test",
      approvalRequestId: 8,
      withFactoryLabel: true,
    });
    expect(confirmation.consequence).toContain("要件定義");
  });

  test("does not claim an implementation for a kind it does not know", () => {
    const confirmation = approvalConfirmation({
      kind: "other",
      subject: "Something",
      approvalRequestId: 9,
      withFactoryLabel: undefined,
    });
    expect(confirmation.consequence).not.toContain("実装");
  });

  test("says that it cannot be undone", () => {
    const confirmation = approvalConfirmation({
      kind: "requirements",
      subject: "Add feature",
      approvalRequestId: 7,
      withFactoryLabel: undefined,
    });
    expect(confirmation.consequence).toContain("取り消せません");
  });
});

describe("approvalLinks", () => {
  test("links requirements to the document of its attempt", () => {
    expect(
      approvalLinks({
        kind: "requirements",
        work_item_id: 10,
        draft_attempt: 2,
        origin: null,
      }).requirements,
    ).toBe("/items/10/requirements?attempt=2");
  });

  test("links requirements without an attempt to the latest document", () => {
    expect(
      approvalLinks({
        kind: "requirements",
        work_item_id: 10,
        draft_attempt: null,
        origin: null,
      }).requirements,
    ).toBe("/items/10/requirements");
  });

  test("links an audit proposal to its report", () => {
    expect(
      approvalLinks({
        kind: "issue_proposal",
        work_item_id: 11,
        draft_attempt: null,
        origin: "audit",
      }).auditReport,
    ).toBe("/reports/audit/11");
  });

  test("does not link a proposal from a pull request to a report", () => {
    expect(
      approvalLinks({
        kind: "issue_proposal",
        work_item_id: 11,
        draft_attempt: null,
        origin: "pr_fix",
      }).auditReport,
    ).toBeNull();
  });
});

const PENDING = {
  status: "pending",
  expires_at: null,
  kind: "issue_proposal",
  created_issue_number: null,
};

describe("decisionSurface", () => {
  test("offers a decision for a pending request in time", () => {
    expect(decisionSurface(PENDING, NOW)).toBe("decide");
  });

  test("reports a pending request past its deadline as expired", () => {
    expect(
      decisionSurface(
        { ...PENDING, expires_at: "2026-10-10T00:00:00.000Z" },
        NOW,
      ),
    ).toBe("expired");
  });

  test("offers to redo an approved proposal without an issue", () => {
    expect(decisionSurface({ ...PENDING, status: "approved" }, NOW)).toBe(
      "redo_issue",
    );
  });

  test("waits for an approved proposal whose issue exists", () => {
    expect(
      decisionSurface(
        { ...PENDING, status: "approved", created_issue_number: 5 },
        NOW,
      ),
    ).toBe("waiting");
  });

  test("waits for an approved request of requirements", () => {
    expect(
      decisionSurface(
        { ...PENDING, status: "approved", kind: "requirements" },
        NOW,
      ),
    ).toBe("waiting");
  });

  test("shows nothing for a rejected request", () => {
    expect(decisionSurface({ ...PENDING, status: "rejected" }, NOW)).toBe(
      "none",
    );
  });
});

describe("approveGateProblem", () => {
  const OPEN = {
    approval: { status: "pending", expires_at: null },
    nowMs: NOW,
    blockedReason: null,
    fullCheckRequired: false,
    fullChecked: false,
  };

  test("lets an open request through", () => {
    expect(approveGateProblem(OPEN)).toBeNull();
  });

  test("stops when the snapshot cannot be seen", () => {
    expect(approveGateProblem({ ...OPEN, blockedReason: "blocked" })).toBe(
      "blocked",
    );
  });

  test("stops a request whose deadline has passed", () => {
    expect(
      approveGateProblem({
        ...OPEN,
        approval: { status: "pending", expires_at: "2026-10-10T00:00:00.000Z" },
      }),
    ).toBe(EXPIRED_MESSAGE);
  });

  test("stops until a long body is checked on GitHub", () => {
    expect(approveGateProblem({ ...OPEN, fullCheckRequired: true })).toBe(
      FULL_CHECK_MESSAGE,
    );
  });

  test("lets a long body through once it is checked", () => {
    expect(
      approveGateProblem({
        ...OPEN,
        fullCheckRequired: true,
        fullChecked: true,
      }),
    ).toBeNull();
  });
});

describe("rejectConfirmation", () => {
  test("asks to confirm rejecting requirements", () => {
    expect(
      rejectConfirmation({
        kind: "requirements",
        subject: "Add feature",
        approvalRequestId: 7,
      })?.consequence,
    ).toContain("現在のIssue");
  });

  test("does not ask to confirm rejecting a proposal", () => {
    expect(
      rejectConfirmation({
        kind: "issue_proposal",
        subject: "Fix",
        approvalRequestId: 7,
      }),
    ).toBeNull();
  });
});

describe("redoConfirmation", () => {
  const confirmation = redoConfirmation({
    subject: "Fix flaky test",
    approvalRequestId: 8,
  });

  test("says that the recorded label choice is reused", () => {
    expect(confirmation.notes.join("")).toContain("記録済みのラベルの選択");
  });

  test("says that an existing issue is reused by its marker", () => {
    expect(confirmation.notes.join("")).toContain("マーカー");
  });

  test("warns not to press it right after approving", () => {
    expect(confirmation.notes.join("")).toContain("直後は押さないで");
  });
});

describe("proposalOrigin", () => {
  test("names the audit period", () => {
    expect(
      proposalOrigin({
        origin: "audit",
        period_label: "2026-10-01〜2026-10-07",
        pr_number: null,
        claimed_by: null,
      }).text,
    ).toBe("監査 2026-10-01〜2026-10-07");
  });

  test("names the pull request and the assignee", () => {
    expect(
      proposalOrigin({
        origin: "pr_fix",
        period_label: null,
        pr_number: 12,
        claimed_by: "worker",
      }).text,
    ).toBe("PR #12 ・ 担当: worker");
  });

  test("reports a hidden character in the period label", () => {
    expect(
      proposalOrigin({
        origin: "audit",
        period_label: "a\u200Bb",
        pr_number: null,
        claimed_by: null,
      }).replaced,
    ).toBe(true);
  });

  test("reports a hidden character in the assignee", () => {
    expect(
      proposalOrigin({
        origin: "pr_fix",
        period_label: null,
        pr_number: null,
        claimed_by: "a\u202Eb",
      }).replaced,
    ).toBe(true);
  });

  test("does not report plain text", () => {
    expect(
      proposalOrigin({
        origin: "pr_fix",
        period_label: null,
        pr_number: 1,
        claimed_by: "worker",
      }).replaced,
    ).toBe(false);
  });
});

describe("waitingMessage", () => {
  test("says that the issue creation is awaited for a proposal", () => {
    expect(waitingMessage("issue_proposal")).toBe(
      "承認済みです。起票を待っています。",
    );
  });

  test("says that the processing is awaited for other kinds", () => {
    expect(waitingMessage("requirements")).toBe(
      "承認済みです。処理の完了を待っています。",
    );
  });
});

describe("docReadiness", () => {
  const loaded = { isPending: false, isError: false, data: { attempt: 2 } };

  test("cannot identify the attempt when the approval has none", () => {
    expect(docReadiness({ expectedAttempt: null, query: loaded })).toBe(
      "unidentified",
    );
  });

  test("is loading while the document is pending", () => {
    expect(
      docReadiness({
        expectedAttempt: 2,
        query: { isPending: true, isError: false, data: undefined },
      }),
    ).toBe("loading");
  });

  test("is failed when the document could not be read", () => {
    expect(
      docReadiness({
        expectedAttempt: 2,
        query: { isPending: false, isError: true, data: undefined },
      }),
    ).toBe("failed");
  });

  test("is missing when there is no document for the attempt", () => {
    expect(
      docReadiness({
        expectedAttempt: 2,
        query: { isPending: false, isError: false, data: null },
      }),
    ).toBe("missing");
  });

  test("is a mismatch when the shown attempt differs from the approved one", () => {
    expect(docReadiness({ expectedAttempt: 3, query: loaded })).toBe(
      "mismatch",
    );
  });

  test("is ready when the document of the approved attempt is shown", () => {
    expect(docReadiness({ expectedAttempt: 2, query: loaded })).toBe("ready");
  });
});

describe("requirementsBlockedReason", () => {
  test("lets approval through when both are ready", () => {
    expect(requirementsBlockedReason("ready", "ready")).toBeNull();
  });

  test("blocks while the snapshot is loading", () => {
    expect(requirementsBlockedReason("loading", "ready")).toContain(
      "取り込み時点のIssue",
    );
  });

  test("blocks when the snapshot is empty", () => {
    expect(requirementsBlockedReason("empty", "ready")).toContain("ありません");
  });

  test("blocks while the document is loading", () => {
    expect(requirementsBlockedReason("ready", "loading")).toContain(
      "要件定義書",
    );
  });

  test("blocks when the document failed to load", () => {
    expect(requirementsBlockedReason("ready", "failed")).toContain("取得");
  });

  test("blocks when the attempt cannot be identified", () => {
    expect(requirementsBlockedReason("ready", "unidentified")).toContain(
      "承認する試行が特定できない",
    );
  });

  test("blocks when the document of the attempt is missing", () => {
    expect(requirementsBlockedReason("ready", "missing")).toContain("見つかり");
  });

  test("blocks when the shown attempt differs", () => {
    expect(requirementsBlockedReason("ready", "mismatch")).toContain("試行");
  });

  test("reports the snapshot first when both are not ready", () => {
    expect(requirementsBlockedReason("failed", "loading")).toContain(
      "取り込み時点のIssue",
    );
  });
});

describe("holdWhileLoadingShown", () => {
  test("treats a ready document as loading while the skeleton is still shown", () => {
    expect(holdWhileLoadingShown("ready", true)).toBe("loading");
  });

  test("keeps a ready document ready once the skeleton is gone", () => {
    expect(holdWhileLoadingShown("ready", false)).toBe("ready");
  });

  test("treats a failure as loading while the skeleton is still shown", () => {
    expect(holdWhileLoadingShown("failed", true)).toBe("loading");
  });

  test("keeps a failure once the skeleton is gone", () => {
    expect(holdWhileLoadingShown("failed", false)).toBe("failed");
  });

  test("keeps a missing snapshot as it is when nothing is shown", () => {
    expect(holdWhileLoadingShown("empty", false)).toBe("empty");
  });

  test("blocks the approval with the loading reason while the document skeleton is shown", () => {
    expect(
      requirementsBlockedReason("ready", holdWhileLoadingShown("ready", true)),
    ).toBe("要件定義書を読み込み中です。表示されるまで承認できません。");
  });

  test("blocks the approval with the loading reason while the snapshot skeleton is shown", () => {
    expect(
      requirementsBlockedReason(holdWhileLoadingShown("ready", true), "ready"),
    ).toBe(
      "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
    );
  });

  test("lets the approval through once nothing is shown", () => {
    expect(
      requirementsBlockedReason(
        holdWhileLoadingShown("ready", false),
        holdWhileLoadingShown("ready", false),
      ),
    ).toBeNull();
  });
});
