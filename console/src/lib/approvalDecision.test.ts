import { describe, expect, test } from "bun:test";
import { MAX_REASON_LENGTH } from "../api/writes.ts";
import {
  approvalConfirmation,
  approvalLinks,
  factoryLabelChoice,
  isDecidable,
  reasonCounter,
  rejectProblem,
  snapshotReadiness,
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
    expect(snapshotReadiness({ isPending: true, isError: false })).toBe(
      "loading",
    );
  });

  test("is failed when the snapshot could not be read", () => {
    expect(snapshotReadiness({ isPending: false, isError: true })).toBe(
      "failed",
    );
  });

  test("is ready when the snapshot is read", () => {
    expect(snapshotReadiness({ isPending: false, isError: false })).toBe(
      "ready",
    );
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
