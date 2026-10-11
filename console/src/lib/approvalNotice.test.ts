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

  test("reports a redone issue creation in its own words", () => {
    const outcome: WriteOutcome<ApprovalDecideResult> = {
      kind: "done",
      result: APPROVED,
    };
    expect(approvalOutcomeNotice(outcome, "redo").message).toBe(
      "Issueの作成をやり直しました。",
    );
  });

  test("reports a definite refusal in Japanese instead of the raw message", () => {
    const outcome: WriteOutcome<ApprovalDecideResult> = {
      kind: "failed",
      error: {
        kind: "job_failed",
        message:
          "approval_decide: the issue could not be compared with the intake content, so approval request 3 was not approved.",
      },
      message: "処理に失敗した可能性があります。",
    };
    expect(approvalOutcomeNotice(outcome).message).toBe(
      "現在のIssueを取り込み内容と比べられなかったため、承認は記録されていません。",
    );
  });
});
