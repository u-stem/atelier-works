import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TIMEOUT_SEC,
  buildApprovalConsoleUrl,
  buildAuditConsoleUrl,
  buildConsoleUrl,
  buildItemsConsoleUrl,
  buildNoticeConsoleUrl,
  buildRecordedReason,
  buildSystemConsoleUrl,
  classifyExistingDecision,
  computeExpiresAt,
  handlerPathFor,
  isExpired,
  issueCheckRefusal,
  needsIssueCheck,
} from "../../f/factory/lib/approval_support.ts";

describe("computeExpiresAt", () => {
  test("adds APPROVAL_TIMEOUT_SEC to now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expected = new Date(now.getTime() + APPROVAL_TIMEOUT_SEC * 1000);
    expect(computeExpiresAt(now)).toEqual(expected);
  });
});

describe("isExpired", () => {
  const NOW = new Date("2026-01-08T00:00:00.000Z");

  test("is expired when pending and expires_at has passed", () => {
    const request = {
      status: "pending" as const,
      expires_at: new Date("2026-01-07T00:00:00.000Z"),
    };
    expect(isExpired(request, NOW)).toBe(true);
  });

  test("is not expired when pending but expires_at is still in the future", () => {
    const request = {
      status: "pending" as const,
      expires_at: new Date("2026-01-09T00:00:00.000Z"),
    };
    expect(isExpired(request, NOW)).toBe(false);
  });

  test("is not expired when expires_at is null (no deadline)", () => {
    const request = { status: "pending" as const, expires_at: null };
    expect(isExpired(request, NOW)).toBe(false);
  });

  test("is not expired when status is not pending, even past the deadline", () => {
    const request = {
      status: "approved" as const,
      expires_at: new Date("2026-01-01T00:00:00.000Z"),
    };
    expect(isExpired(request, NOW)).toBe(false);
  });
});

describe("classifyExistingDecision", () => {
  test("records and dispatches when the row is still pending", () => {
    expect(classifyExistingDecision("pending", "approved")).toBe(
      "record_and_dispatch",
    );
  });

  test("redispatches only when the existing decision matches (idempotent retry)", () => {
    expect(classifyExistingDecision("approved", "approved")).toBe("redispatch");
  });

  test("refuses when the existing decision differs (genuine conflict)", () => {
    expect(classifyExistingDecision("approved", "rejected")).toBe("refuse");
  });

  test("refuses when the row has already expired", () => {
    expect(classifyExistingDecision("expired", "approved")).toBe("refuse");
  });
});

describe("buildRecordedReason", () => {
  test("returns the reason alone when there is no note", () => {
    expect(buildRecordedReason("missing tests", "")).toBe("missing tests");
  });

  test("folds a non-empty note into the recorded text", () => {
    expect(buildRecordedReason("missing tests", "saw this in CI")).toContain(
      "saw this in CI",
    );
  });

  test("still includes the original reason when a note is also given", () => {
    expect(buildRecordedReason("missing tests", "saw this in CI")).toContain(
      "missing tests",
    );
  });

  test("returns null when both reason and note are empty", () => {
    expect(buildRecordedReason("", "")).toBeNull();
  });

  test("uses the note alone when reason is empty (an approve with a note)", () => {
    expect(buildRecordedReason("", "looks good")).toContain("looks good");
  });
});

describe("buildConsoleUrl", () => {
  test("builds the entrance of the new Console under windmill_public_url", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/console/",
    );
  });

  test("does not contain a getResumeUrls-style capability token", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080")).not.toContain("token=");
  });

  test("links the requirements page of the work item when a target is given", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080", { work_item_id: 42 })).toBe(
      "http://127.0.0.1:8080/console/items/42/requirements",
    );
  });

  test("adds the attempt query when the target has an attempt", () => {
    expect(
      buildConsoleUrl("http://127.0.0.1:8080", {
        work_item_id: 42,
        attempt: 3,
      }),
    ).toBe("http://127.0.0.1:8080/console/items/42/requirements?attempt=3");
  });
});

describe("buildApprovalConsoleUrl", () => {
  test("selects the approval in the inbox of the Console", () => {
    expect(buildApprovalConsoleUrl("http://127.0.0.1:8080", 9)).toBe(
      "http://127.0.0.1:8080/console/?approval=9",
    );
  });
});

describe("buildNoticeConsoleUrl", () => {
  test("selects the notice in the inbox of the Console", () => {
    expect(buildNoticeConsoleUrl("http://127.0.0.1:8080", 7)).toBe(
      "http://127.0.0.1:8080/console/?notice=7",
    );
  });
});

describe("buildAuditConsoleUrl", () => {
  test("links the audit report page", () => {
    expect(buildAuditConsoleUrl("http://127.0.0.1:8080", 12)).toBe(
      "http://127.0.0.1:8080/console/reports/audit/12",
    );
  });
});

describe("buildItemsConsoleUrl", () => {
  test("links the work items screen", () => {
    expect(buildItemsConsoleUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/console/items",
    );
  });

  test("can open the whole list, which includes the finished work items", () => {
    expect(
      buildItemsConsoleUrl("http://127.0.0.1:8080", { scope: "all" }),
    ).toBe("http://127.0.0.1:8080/console/items?scope=all");
  });
});

describe("buildSystemConsoleUrl", () => {
  test("links the system screen", () => {
    expect(buildSystemConsoleUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/console/system",
    );
  });
});

describe("handlerPathFor", () => {
  test("routes requirements to requirements_apply", () => {
    expect(handlerPathFor("requirements")).toBe(
      "f/factory/steps/requirements_apply",
    );
  });

  test("routes issue_proposal to issue_proposal_apply", () => {
    expect(handlerPathFor("issue_proposal")).toBe(
      "f/factory/steps/issue_proposal_apply",
    );
  });

  test("throws for design, which has no handler yet", () => {
    expect(() => handlerPathFor("design")).toThrow(
      "no approval handler for kind design",
    );
  });
});

describe("needsIssueCheck", () => {
  test("checks a new approval of requirements", () => {
    expect(
      needsIssueCheck("record_and_dispatch", "approve", "requirements"),
    ).toBe(true);
  });

  test("does not check a rejection", () => {
    expect(
      needsIssueCheck("record_and_dispatch", "reject", "requirements"),
    ).toBe(false);
  });

  test("does not check the rerun of a recorded decision", () => {
    expect(needsIssueCheck("redispatch", "approve", "requirements")).toBe(
      false,
    );
  });

  test("does not check a refused decision", () => {
    expect(needsIssueCheck("refuse", "approve", "requirements")).toBe(false);
  });

  test("does not check an issue proposal", () => {
    expect(
      needsIssueCheck("record_and_dispatch", "approve", "issue_proposal"),
    ).toBe(false);
  });

  test("checks a new approval of a design", () => {
    expect(needsIssueCheck("record_and_dispatch", "approve", "design")).toBe(
      true,
    );
  });

  test("does not check a rejection of a design", () => {
    expect(needsIssueCheck("record_and_dispatch", "reject", "design")).toBe(
      false,
    );
  });

  test("does not check the rerun of a recorded decision of a design", () => {
    expect(needsIssueCheck("redispatch", "approve", "design")).toBe(false);
  });
});

describe("issueCheckRefusal", () => {
  test("allows approval when the issue matches the intake snapshot", () => {
    expect(issueCheckRefusal("match", 7)).toBeNull();
  });

  test("allows approval when the check does not apply", () => {
    expect(issueCheckRefusal("not_applicable", 7)).toBeNull();
  });

  test("refuses approval when the issue changed after intake", () => {
    expect(issueCheckRefusal("changed", 7)).toContain("changed after intake");
  });

  test("tells the approver that rejecting regenerates from the current issue", () => {
    expect(issueCheckRefusal("changed", 7)).toContain(
      "reject the request; the requirements are regenerated from the current issue",
    );
  });

  test("names the screen that shows the intake content", () => {
    expect(issueCheckRefusal("changed", 7)).toContain(
      "Inbox of the new Console",
    );
  });

  test("refuses approval when the issue could not be fetched", () => {
    expect(issueCheckRefusal("unavailable", 7)).toContain("try again");
  });

  test("tells the approver to reject when the issue was moved or deleted", () => {
    expect(issueCheckRefusal("unavailable", 7)).toContain(
      "If the issue was transferred or deleted, reject the request.",
    );
  });

  test("names the approval request in the refusal", () => {
    expect(issueCheckRefusal("changed", 7)).toContain("approval request 7");
  });

  test("tells the approver of a design that rejecting regenerates from the current issue", () => {
    expect(issueCheckRefusal("changed", 7, "design")).toContain(
      "reject the request; the requirements are regenerated from the current issue",
    );
  });

  test("keeps the marker the console matches when a design could not be compared", () => {
    expect(issueCheckRefusal("unavailable", 7, "design")).toContain(
      "the issue could not be compared",
    );
  });

  test("tells the approver of a design that rejections are limited by max_design_attempts", () => {
    expect(issueCheckRefusal("unavailable", 7, "design")).toContain(
      "max_design_attempts",
    );
  });

  test("keeps the sentence for requirements when the kind is requirements", () => {
    expect(issueCheckRefusal("unavailable", 7, "requirements")).toContain(
      "If the issue was transferred or deleted, reject the request.",
    );
  });

  test("does not mention max_design_attempts for requirements", () => {
    expect(issueCheckRefusal("unavailable", 7, "requirements")).not.toContain(
      "max_design_attempts",
    );
  });
});

describe("the imports of approval_support", () => {
  // `approval_decide`はConsole用のworkerで動き、`approval_support.ts`を読み込む。
  // 走査の表と設計の定数は、このファイルから読み込まれない場所に置く。
  async function importSpecifiers(): Promise<string[]> {
    const source = await Bun.file(
      new URL("../../f/factory/lib/approval_support.ts", import.meta.url),
    ).text();
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    return [...code.matchAll(/from\s+["']([^"']+)["']/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
  }

  test("does not import the approval sweep", async () => {
    expect(
      (await importSpecifiers()).filter((path) =>
        path.includes("approval_sweep"),
      ),
    ).toEqual([]);
  });

  test("does not import the design template", async () => {
    expect(
      (await importSpecifiers()).filter((path) =>
        path.includes("design_template"),
      ),
    ).toEqual([]);
  });

  test("no longer filters the expired requests of requirements", async () => {
    const source = await Bun.file(
      new URL("../../f/factory/lib/approval_support.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("expiredRequirementsRequests");
  });
});
