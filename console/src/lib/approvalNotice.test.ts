import { describe, expect, test } from "bun:test";
import type { WriteOutcome } from "../api/executeWrite.ts";
import type { ApprovalDecideResult } from "../api/guards/writeResults.ts";
import { approvalOutcomeNotice } from "./approvalNotice.ts";

const APPROVED: ApprovalDecideResult = {
  ok: true,
  status: "approved",
  job_id: "job-1",
};

describe("approvalOutcomeNotice", () => {
  test("reports an approval as a success", () => {
    const outcome: WriteOutcome<ApprovalDecideResult> = {
      kind: "done",
      result: APPROVED,
    };
    expect(approvalOutcomeNotice(outcome)).toEqual({
      tone: "success",
      message: "承認しました。",
    });
  });

  test("reports a rejection as a success", () => {
    const outcome: WriteOutcome<ApprovalDecideResult> = {
      kind: "done",
      result: { ...APPROVED, status: "rejected" },
    };
    expect(approvalOutcomeNotice(outcome).message).toBe("却下しました。");
  });

  test("reports a failure as an error with the described message", () => {
    const outcome: WriteOutcome<ApprovalDecideResult> = {
      kind: "failed",
      error: { kind: "forbidden" },
      message: "権限がありません。",
    };
    expect(approvalOutcomeNotice(outcome)).toEqual({
      tone: "error",
      message: "権限がありません。",
    });
  });
});
