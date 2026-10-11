import { describe, expect, test } from "bun:test";
import {
  assertIssueMatchesIntake,
  assertValidApprovalDecideInput,
} from "../../f/factory/approval_decide.ts";

describe("assertIssueMatchesIntake", () => {
  const verdictOf = (verdict: string) => () => Promise.resolve({ verdict });

  test("passes when the issue matches the intake snapshot", async () => {
    const result = assertIssueMatchesIntake(
      5,
      "requirements",
      verdictOf("match"),
    );
    await expect(result).resolves.toBeUndefined();
  });

  test("refuses when the issue changed after intake", async () => {
    const result = assertIssueMatchesIntake(
      5,
      "requirements",
      verdictOf("changed"),
    );
    await expect(result).rejects.toThrow("changed after intake");
  });

  test("refuses when the check could not compare the issue", async () => {
    const result = assertIssueMatchesIntake(
      5,
      "requirements",
      verdictOf("unavailable"),
    );
    await expect(result).rejects.toThrow("try again");
  });

  test("refuses when the check job fails", async () => {
    const result = assertIssueMatchesIntake(5, "requirements", () =>
      Promise.reject(new Error("job timed out")),
    );
    await expect(result).rejects.toThrow("try again");
  });

  test("refuses when the check returns an unexpected shape", async () => {
    const result = assertIssueMatchesIntake(5, "requirements", () =>
      Promise.resolve("match"),
    );
    await expect(result).rejects.toThrow("try again");
  });

  test("runs the check script on the approval request", async () => {
    const calls: unknown[] = [];
    await assertIssueMatchesIntake(5, "requirements", (path, args) => {
      calls.push([path, args]);
      return Promise.resolve({ verdict: "match" });
    });
    expect(calls).toEqual([
      ["f/factory/steps/approval_check_issue", { approval_request_id: 5 }],
    ]);
  });

  test("skips the check for an issue proposal", async () => {
    let calls = 0;
    await assertIssueMatchesIntake(5, "issue_proposal", () => {
      calls += 1;
      return Promise.resolve({ verdict: "changed" });
    });
    expect(calls).toBe(0);
  });
});

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
