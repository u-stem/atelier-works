// 新規投入の1回の送信の結果と、その後の画面の振る舞い。画面から切り離した純関数にして、`bun test`で確かめる。
//
// 投入されたか分からない失敗(ジョブの失敗、待ちの上限、形が違う応答、通信の失敗、5xx)は、
// フローを起動した後にも起こりうる。そのときは入力を残し、送信を止める。
// 再送には「確かめたので再送する」の明示の操作を挟む。
// 止めるのはこのタブの中だけで、別のタブやリロードの後の二重の送信は止められない。

import { isResultUnknown, type WriteOutcome } from "../api/executeWrite.ts";
import type { ManualIntakeSubmitResult } from "../api/guards/writeResults.ts";
import { describeIntakeRefusal } from "./intakeRefusal.ts";

export type IntakeAttempt =
  | { readonly kind: "idle" }
  /** scriptが検証で断った。フローは起動していない。 */
  | { readonly kind: "refused"; readonly message: string }
  /** ジョブが動く前に断られた(401、403、4xx)。投入されていない。 */
  | { readonly kind: "rejected"; readonly message: string }
  /** 投入されたか分からない。 */
  | {
      readonly kind: "unknown";
      readonly message: string;
      /** 利用者が、ジョブ一覧とIssueで確かめたと明示したか。 */
      readonly resendConfirmed: boolean;
    }
  | { readonly kind: "submitted"; readonly flowJobId: string };

/** 書き込みの結果を、1回の送信の状態にする。 */
export function attemptFromOutcome(
  outcome: WriteOutcome<ManualIntakeSubmitResult>,
): IntakeAttempt {
  if (outcome.kind === "failed") {
    return isResultUnknown(outcome.error)
      ? { kind: "unknown", message: outcome.message, resendConfirmed: false }
      : { kind: "rejected", message: outcome.message };
  }
  const result = outcome.result;
  return result.refused
    ? { kind: "refused", message: describeIntakeRefusal(result.reason) }
    : { kind: "submitted", flowJobId: result.flow_job_id };
}

/** 送信のボタンを止めるか。投入されたか分からないとき、確かめたと明示するまで止める。 */
export function isSubmitBlocked(attempt: IntakeAttempt): boolean {
  return attempt.kind === "unknown" && !attempt.resendConfirmed;
}

/** 「確かめたので再送する」の操作。投入されたか分からないときだけ、送信を開ける。 */
export function confirmResend(attempt: IntakeAttempt): IntakeAttempt {
  return attempt.kind === "unknown"
    ? { ...attempt, resendConfirmed: true }
    : attempt;
}

/** 入力欄の値を残すか。投入できたときだけ空に戻す。 */
export function keepsInput(attempt: IntakeAttempt): boolean {
  return attempt.kind !== "submitted";
}

/** 画面に出す結果の知らせ。 */
export type IntakeAttemptView = {
  readonly tone: "success" | "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
  /** 投入のフローのジョブ。ジョブの画面へのリンクに使う。 */
  readonly flowJobId: string | null;
};

const SUBMITTED_LINES = [
  "Issueを作り、作業項目として登録する処理を始めました。",
  "作業項目は、登録の後に作業項目の一覧へ現れます。",
  "現れないときは、システムの画面の「作業項目に紐づかない失敗」を確かめてください。",
] as const;

const UNKNOWN_LINES = [
  "入力は残してあります。",
  "再送する前に、次の2か所で投入されたかを確かめてください。",
  "Windmillのジョブ一覧で、manual_intakeのジョブを探す。",
  "対象リポジトリのIssueで、同じ題名のIssueを探す。",
  "投入されていないと分かったら、「確かめたので再送する」を押してください。",
] as const;

/** 送信の状態を、画面に出す知らせにする。まだ送っていないときは`null`を返す。 */
export function describeIntakeAttempt(
  attempt: IntakeAttempt,
): IntakeAttemptView | null {
  switch (attempt.kind) {
    case "idle":
      return null;
    case "submitted":
      return {
        tone: "success",
        headline: "投入しました",
        lines: SUBMITTED_LINES,
        flowJobId: attempt.flowJobId,
      };
    case "refused":
    case "rejected":
      return {
        tone: "error",
        headline: "投入できませんでした",
        lines: [attempt.message],
        flowJobId: null,
      };
    case "unknown":
      return {
        tone: "warning",
        headline: "投入されたか分かりません",
        lines: [attempt.message, ...UNKNOWN_LINES],
        flowJobId: null,
      };
  }
}
