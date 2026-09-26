import { describe, expect, test } from "bun:test";
import {
  assertValidApprovalDecideInput,
  buildRecordedReason,
  classifyExistingApproval,
  deriveApprover,
  isDecisionForCurrentAttempt,
  resolveInternalBase,
  toInternalUrl,
} from "../../f/factory/approval_decide.ts";

describe("assertValidApprovalDecideInput", () => {
  test("allows an approve decision with an empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "approve", reason: "" }),
    ).not.toThrow();
  });

  test("allows a reject decision with a non-empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({
        decision: "reject",
        reason: "missing tests",
      }),
    ).not.toThrow();
  });

  test("rejects a reject decision with an empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "reject", reason: "" }),
    ).toThrow();
  });

  test("rejects a reject decision with a whitespace-only reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "reject", reason: "   " }),
    ).toThrow();
  });
});

describe("deriveApprover", () => {
  test("prefers WM_USERNAME when set", () => {
    expect(
      deriveApprover({ WM_USERNAME: "alice", WM_EMAIL: "alice@example.com" }),
    ).toBe("alice");
  });

  test("falls back to WM_EMAIL when WM_USERNAME is unset", () => {
    expect(deriveApprover({ WM_EMAIL: "alice@example.com" })).toBe(
      "alice@example.com",
    );
  });

  test("falls back to WM_EMAIL when WM_USERNAME is empty", () => {
    expect(
      deriveApprover({ WM_USERNAME: "", WM_EMAIL: "alice@example.com" }),
    ).toBe("alice@example.com");
  });

  test("throws when neither WM_USERNAME nor WM_EMAIL is set", () => {
    expect(() => deriveApprover({})).toThrow();
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

describe("isDecisionForCurrentAttempt", () => {
  test("matches when the latest draft's attempt equals the work item's attempt", () => {
    expect(isDecisionForCurrentAttempt(2, 2)).toBe(true);
  });

  test("does not match a stale draft attempt", () => {
    expect(isDecisionForCurrentAttempt(1, 2)).toBe(false);
  });

  test("does not match when there is no draft at all", () => {
    expect(isDecisionForCurrentAttempt(null, 1)).toBe(false);
  });
});

describe("classifyExistingApproval", () => {
  test("records and posts when no approval exists yet", () => {
    expect(classifyExistingApproval(null, "approved")).toBe("record_and_post");
  });

  test("reposts only when the existing decision matches (idempotent retry)", () => {
    expect(classifyExistingApproval({ decision: "approved" }, "approved")).toBe(
      "repost_only",
    );
  });

  test("rejects when the existing decision differs (genuine conflict)", () => {
    expect(classifyExistingApproval({ decision: "approved" }, "rejected")).toBe(
      "reject",
    );
  });
});

describe("toInternalUrl", () => {
  const RESUME_URL =
    "http://127.0.0.1:8080/api/w/factory/jobs_u/resume/abc?token=secret";

  test("returns the url unchanged when internalBase is undefined", () => {
    expect(toInternalUrl(RESUME_URL, undefined)).toBe(RESUME_URL);
  });

  test("returns the url unchanged when internalBase is empty", () => {
    expect(toInternalUrl(RESUME_URL, "")).toBe(RESUME_URL);
  });

  test("rewrites the origin to internalBase while keeping the path and query", () => {
    expect(toInternalUrl(RESUME_URL, "http://windmill-server:8000")).toBe(
      "http://windmill-server:8000/api/w/factory/jobs_u/resume/abc?token=secret",
    );
  });
});

describe("resolveInternalBase", () => {
  test("prefers BASE_INTERNAL_URL when both are set", () => {
    expect(
      resolveInternalBase({
        BASE_INTERNAL_URL: "http://internal:8000",
        BASE_URL: "http://external:8080",
      }),
    ).toBe("http://internal:8000");
  });

  test("falls back to BASE_URL when BASE_INTERNAL_URL is unset (the measured worker env)", () => {
    expect(resolveInternalBase({ BASE_URL: "http://external:8080" })).toBe(
      "http://external:8080",
    );
  });

  test("returns undefined when neither is set", () => {
    expect(resolveInternalBase({})).toBeUndefined();
  });
});
