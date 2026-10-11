import { describe, expect, test } from "bun:test";
import type { ApiError } from "../api/errors.ts";
import { classifyDecisionRefusal } from "./approvalRefusal.ts";

function jobFailed(message: string): ApiError {
  return { kind: "job_failed", message };
}

const CHANGED =
  "approval_decide: the issue title or body changed after intake, so approval request 3 was not approved. Claude implements the content captured at intake.";
const UNAVAILABLE =
  "approval_decide: the issue could not be compared with the intake content, so approval request 3 was not approved. Wait a moment and try again.";
const CONFLICT =
  "approval_decide: approval request 3 already has a recorded decision (rejected) that differs from this request (approved), or has expired — refusing to overwrite it";
const REASON =
  'approval_decide: "reason" is required when decision is "reject"';
const MISSING = "approval_decide: no approval request with id 3";

describe("classifyDecisionRefusal", () => {
  test("explains that a rewritten issue stopped the approval", () => {
    expect(classifyDecisionRefusal(jobFailed(CHANGED))?.kind).toBe("changed");
  });

  test("offers to restore the issue or to reject when the issue changed", () => {
    expect(classifyDecisionRefusal(jobFailed(CHANGED))?.actions).toHaveLength(
      2,
    );
  });

  test("says in Japanese that nothing was recorded when the issue changed", () => {
    expect(classifyDecisionRefusal(jobFailed(CHANGED))?.message).toBe(
      "Issueが取り込みの後に書き換えられているため、承認は記録されていません。",
    );
  });

  test("explains that the issue could not be compared", () => {
    expect(classifyDecisionRefusal(jobFailed(UNAVAILABLE))?.kind).toBe(
      "unavailable",
    );
  });

  test("offers to wait and retry, or to reject, when the issue could not be compared", () => {
    expect(
      classifyDecisionRefusal(jobFailed(UNAVAILABLE))?.actions.join(""),
    ).toContain("待って");
  });

  test("explains a decision that is already recorded or expired", () => {
    expect(classifyDecisionRefusal(jobFailed(CONFLICT))?.kind).toBe("conflict");
  });

  test("explains a rejection without a reason", () => {
    expect(classifyDecisionRefusal(jobFailed(REASON))?.kind).toBe(
      "reason_required",
    );
  });

  test("explains a request that does not exist", () => {
    expect(classifyDecisionRefusal(jobFailed(MISSING))?.kind).toBe("missing");
  });

  test("leaves an unrecognized approval_decide failure to the generic message", () => {
    expect(
      classifyDecisionRefusal(jobFailed("approval_decide: boom")),
    ).toBeNull();
  });

  test("ignores a failure that does not start with the script prefix", () => {
    expect(
      classifyDecisionRefusal(
        jobFailed(
          "retry_work_item: the issue title or body changed after intake",
        ),
      ),
    ).toBeNull();
  });

  test("ignores a prefix that appears later in the message", () => {
    expect(classifyDecisionRefusal(jobFailed(`x ${CHANGED}`))).toBeNull();
  });

  test("ignores an error that is not a job failure", () => {
    expect(classifyDecisionRefusal({ kind: "network" })).toBeNull();
  });
});
