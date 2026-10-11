// 承認・却下の結果を、トーストに出す知らせにする。
// 失敗の文は`describeApiError`が作った文をそのまま使い、結果が分からない失敗の案内もそこに含まれる。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type { ApprovalDecideResult } from "../api/guards/writeResults.ts";
import { classifyDecisionRefusal } from "./approvalRefusal.ts";
import { describeApprovalResult } from "./writeNotices.ts";

export type ToastNotice = {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly message: string;
};

/**
 * 承認・却下の結果の知らせ。`redo`は、承認済みの提案のIssue作成をやり直した結果である。
 * scriptの確定した断りは、結果が分からない失敗の案内ではなく、断りの文を出す。
 */
export function approvalOutcomeNotice(
  outcome: WriteOutcome<ApprovalDecideResult>,
  mode: "decide" | "redo" = "decide",
): ToastNotice {
  if (outcome.kind === "done") {
    return mode === "redo"
      ? { tone: "success", message: "Issueの作成をやり直しました。" }
      : describeApprovalResult(outcome.result);
  }
  const refusal = classifyDecisionRefusal(outcome.error);
  return {
    tone: "error",
    message: refusal === null ? outcome.message : refusal.message,
  };
}
