// PRレビューの投入の、同期の結果と送信ボタンの状態。画面から切り離した純関数にして、`bun test`で確かめる。
//
// 同期の結果は4つある。入口が断った(`refused`)、起動した(`submitted`)、
// 失敗で結果が分かる(`failed`。403と4xx)、失敗で投入されたか分からない(`unknown`)。
// 投入されたか分からないときも、再送を止めない。再送しても、同じPRで稼働中のレビューがあれば入口が断るか、
// 登録のステップが一意インデックスで断るので、レビューは二重に始まらない。

import { isResultUnknown, type WriteOutcome } from "../api/executeWrite.ts";
import type { PrReviewSubmitResult } from "../api/guards/writeResults.ts";
import { describePrReviewSubmitRefusal } from "./prReviewRefusal.ts";
import type { PrReviewResultState } from "./prReviewResult.ts";
import { ACTION_AUDIT_FAILED_NOTE } from "./writeNotices.ts";

export type PrReviewAttempt =
  /** 入口が検証で断った。フローは起動していない。 */
  | { readonly kind: "refused"; readonly message: string }
  /** ジョブが動く前に断られた(401、403、4xx)。投入されていない。 */
  | { readonly kind: "failed"; readonly message: string }
  /** 投入されたか分からない。 */
  | { readonly kind: "unknown"; readonly message: string }
  | {
      readonly kind: "submitted";
      readonly flowJobId: string;
      /** 操作の記録を書けなかったか。投入は済んでいる。 */
      readonly auditFailed: boolean;
    };

/** 書き込みの結果を、1回の送信の状態にする。 */
export function attemptFromOutcome(
  outcome: WriteOutcome<PrReviewSubmitResult>,
): PrReviewAttempt {
  if (outcome.kind === "failed") {
    return isResultUnknown(outcome.error)
      ? { kind: "unknown", message: outcome.message }
      : { kind: "failed", message: outcome.message };
  }
  const result = outcome.result;
  return result.refused
    ? {
        kind: "refused",
        message: describePrReviewSubmitRefusal(result.reason),
      }
    : {
        kind: "submitted",
        flowJobId: result.flow_job_id,
        auditFailed: result.action_audit === "failed",
      };
}

/** 画面に出す、同期の結果の知らせ。 */
export type PrReviewAttemptView = {
  readonly tone: "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
};

const RESEND_LINE =
  "再送しても、同じPRのレビューが二重に始まることはありません。投入されたかは、作業項目の一覧かジョブの一覧で確かめられます。";

/**
 * 送信の状態を、画面に出す知らせにする。起動できたときは`null`を返す。
 * 起動後の結果は、投入したフローのジョブの結果が伝える。
 */
export function describePrReviewAttempt(
  attempt: PrReviewAttempt,
): PrReviewAttemptView | null {
  switch (attempt.kind) {
    case "submitted":
      return null;
    case "refused":
    case "failed":
      return {
        tone: "error",
        headline: "投入できませんでした",
        lines: [attempt.message],
      };
    case "unknown":
      return {
        tone: "warning",
        headline: "投入されたか分かりません",
        lines: [attempt.message, RESEND_LINE],
      };
  }
}

/** 操作の記録を残せなかったときの注意。ほかの書き込みと同じ文を使う。 */
export function auditFailedNote(attempt: PrReviewAttempt): string | null {
  return attempt.kind === "submitted" && attempt.auditFailed
    ? ACTION_AUDIT_FAILED_NOTE
    : null;
}

/**
 * 結果を受け取った時点で、投入したフローの結果を待ち始めるか。起動できたときだけ待つ。
 * 結果の部品が描かれてから待ちを知らせると、その間に次の投入を送れてしまうので、受け取った時点で真にする。
 */
export function startsWaiting(attempt: PrReviewAttempt): boolean {
  return attempt.kind === "submitted";
}

/**
 * 送信を始めた後に残す、前の結果。始められたときだけ消す。
 * ロック中で始められなかったときは、前の結果をそのまま見せる。
 */
export function attemptAfterSubmit(
  started: boolean,
  previous: PrReviewAttempt | null,
): PrReviewAttempt | null {
  return started ? null : previous;
}

/**
 * 作業項目の一覧を読み直すか。レビューが始まったと分かったとき、投入したフローのジョブごとに1回だけ読み直す。
 * 一覧が最大30秒古いままにならないためである。
 */
export function shouldRefreshPipeline(
  state: PrReviewResultState,
  refreshedFor: string | null,
  flowJobId: string,
): boolean {
  return state.kind === "started" && refreshedFor !== flowJobId;
}

export type SubmitControl = {
  readonly disabled: boolean;
  readonly label: string;
};

/**
 * 送信ボタンの状態。送信中は、画面が外れて戻っても共有のロックが残るので、ロックから決める。
 * 結果を待つ間は、次の投入が前の結果を上書きしないよう、止める。
 */
export function submitControl(state: {
  readonly locked: boolean;
  readonly waiting: boolean;
}): SubmitControl {
  return {
    disabled: state.locked || state.waiting,
    label: state.locked ? "投入しています" : "レビューを投入する",
  };
}
