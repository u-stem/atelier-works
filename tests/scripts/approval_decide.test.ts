import { describe, expect, test } from "bun:test";
import { assertValidApprovalDecideInput } from "../../f/factory/approval_decide.ts";

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
