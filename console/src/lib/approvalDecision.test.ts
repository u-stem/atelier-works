import { describe, expect, test } from "bun:test";
import { MAX_REASON_LENGTH } from "../api/writes.ts";
import {
  approvalConfirmation,
  approvalLinks,
  approveGateProblem,
  decisionSurface,
  EXPIRED_MESSAGE,
  FULL_CHECK_MESSAGE,
  factoryLabelChoice,
  isDecidable,
  proposalOrigin,
  reasonCounter,
  redoConfirmation,
  rejectConfirmation,
  rejectProblem,
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
