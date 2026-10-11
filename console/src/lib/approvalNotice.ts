// 承認・却下の結果を、トーストに出す知らせにする。
// 失敗の文は`describeApiError`が作った文をそのまま使い、結果が分からない失敗の案内もそこに含まれる。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type { ApprovalDecideResult } from "../api/guards/writeResults.ts";
import { describeApprovalResult } from "./writeNotices.ts";

export type ToastNotice = {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly message: string;
};

export function approvalOutcomeNotice(
  outcome: WriteOutcome<ApprovalDecideResult>,
): ToastNotice {
  if (outcome.kind === "done") {
    return describeApprovalResult(outcome.result);
  }
  return { tone: "error", message: outcome.message };
}
