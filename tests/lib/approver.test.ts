// Tests for f/factory/lib/approver.ts's deriveApprover (team-lead fix round,
// [MUST] #1: shared fail-closed approver-identity derivation, used by
// approval_decide.ts — the single decision recorder for every
// approval_requests kind — instead of a bare
// `process.env.WM_USERNAME ?? "unknown"`).

import { describe, expect, test } from "bun:test";
import { deriveApprover } from "../../f/factory/lib/approver.ts";

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
