import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TIMEOUT_SEC,
  buildConsoleUrl,
  buildRecordedReason,
  classifyExistingDecision,
  computeExpiresAt,
  expiredRequirementsRequests,
  handlerPathFor,
  isExpired,
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
  test("builds the App's view URL under windmill_public_url", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console",
    );
  });

  test("does not contain a getResumeUrls-style capability token", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080")).not.toContain("token=");
  });

  test("appends a requirements deep-link fragment when a target is given", () => {
    expect(buildConsoleUrl("http://127.0.0.1:8080", { work_item_id: 42 })).toBe(
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/42",
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
});

describe("expiredRequirementsRequests", () => {
  test("keeps only requirements-kind requests", () => {
    const requests = [
      { kind: "requirements" as const, id: 1 },
      { kind: "issue_proposal" as const, id: 2 },
    ];
    expect(expiredRequirementsRequests(requests)).toEqual([
      { kind: "requirements", id: 1 },
    ]);
  });

  test("returns an empty array when none are requirements-kind", () => {
    const requests = [{ kind: "issue_proposal" as const, id: 2 }];
    expect(expiredRequirementsRequests(requests)).toEqual([]);
  });
});
