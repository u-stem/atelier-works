import { describe, expect, test } from "bun:test";
import type { ApprovalRequestKind } from "../../f/factory/lib/types.ts";
import {
  type CheckApprovalIssueDeps,
  checkApprovalIssue,
} from "../../f/factory/steps/approval_check_issue.ts";

const SNAPSHOT = {
  kind: "issue" as const,
  owner: "o",
  repo: "r",
  issue_number: 42,
  title: "Add feature",
  body: "Original body",
};

function deps(
  overrides: Partial<CheckApprovalIssueDeps> = {},
  kind: ApprovalRequestKind = "requirements",
): CheckApprovalIssueDeps {
  return {
    getApprovalRequest: () => Promise.resolve({ kind, work_item_id: 9 }),
    getWorkItem: () => Promise.resolve(SNAPSHOT),
    getIssue: () =>
      Promise.resolve({ title: "Add feature", body: "Original body" }),
    warn: () => {},
    ...overrides,
  };
}

describe("checkApprovalIssue", () => {
  test("returns match when the live issue equals the intake snapshot", async () => {
    const result = await checkApprovalIssue(5, deps());
    expect(result).toEqual({ verdict: "match" });
  });

  test("returns match when only the line endings differ", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({
        getWorkItem: () => Promise.resolve({ ...SNAPSHOT, body: "a\nb" }),
        getIssue: () =>
          Promise.resolve({ title: "Add feature", body: "a\r\nb" }),
      }),
    );
    expect(result).toEqual({ verdict: "match" });
  });

  test("returns changed when the body was rewritten after intake", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({
        getIssue: () =>
          Promise.resolve({ title: "Add feature", body: "Rewritten body" }),
      }),
    );
    expect(result).toEqual({ verdict: "changed" });
  });

  test("returns changed when the title was rewritten after intake", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({
        getIssue: () =>
          Promise.resolve({ title: "Other title", body: "Original body" }),
      }),
    );
    expect(result).toEqual({ verdict: "changed" });
  });

  test("returns not_applicable for an issue proposal", async () => {
    const result = await checkApprovalIssue(5, deps({}, "issue_proposal"));
    expect(result).toEqual({ verdict: "not_applicable" });
  });

  test("does not call GitHub for an issue proposal", async () => {
    let calls = 0;
    await checkApprovalIssue(
      5,
      deps(
        {
          getIssue: () => {
            calls += 1;
            return Promise.resolve({ title: "", body: "" });
          },
        },
        "issue_proposal",
      ),
    );
    expect(calls).toBe(0);
  });

  test("returns unavailable when GitHub fails", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({ getIssue: () => Promise.reject(new Error("HTTP 502")) }),
    );
    expect(result).toEqual({ verdict: "unavailable" });
  });

  test("logs a GitHub failure without the token", async () => {
    const warnings: string[] = [];
    await checkApprovalIssue(
      5,
      deps({
        getIssue: () =>
          Promise.reject(
            new Error("bad token ghp_abcdefghijklmnopqrstuvwxyz0123"),
          ),
        warn: (message, fields) => {
          warnings.push(`${message} ${JSON.stringify(fields)}`);
        },
      }),
    );
    expect(warnings.join("\n")).not.toContain("ghp_");
  });

  test("returns unavailable when the approval request is missing", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({ getApprovalRequest: () => Promise.resolve(null) }),
    );
    expect(result).toEqual({ verdict: "unavailable" });
  });

  test("returns unavailable when the work item is missing", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({ getWorkItem: () => Promise.resolve(null) }),
    );
    expect(result).toEqual({ verdict: "unavailable" });
  });

  test("returns unavailable when the work item has no issue number", async () => {
    const result = await checkApprovalIssue(
      5,
      deps({
        getWorkItem: () => Promise.resolve({ ...SNAPSHOT, issue_number: null }),
      }),
    );
    expect(result).toEqual({ verdict: "unavailable" });
  });

  test("reads the issue of the work item that the request belongs to", async () => {
    const seen: string[] = [];
    await checkApprovalIssue(
      5,
      deps({
        getIssue: (owner, repo, number) => {
          seen.push(`${owner}/${repo}#${String(number)}`);
          return Promise.resolve({
            title: "Add feature",
            body: "Original body",
          });
        },
      }),
    );
    expect(seen).toEqual(["o/r#42"]);
  });
});
