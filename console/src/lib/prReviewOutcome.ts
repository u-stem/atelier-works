// PRレビューの投入の、同期の結果と送信ボタンの状態。画面から切り離した純関数にして、`bun test`で確かめる。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type { PrReviewSubmitResult } from "../api/guards/writeResults.ts";

export type PrReviewAttempt =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string }
  | {
      readonly kind: "submitted";
      readonly flowJobId: string;
      readonly auditFailed: boolean;
    };

export function attemptFromOutcome(
  _outcome: WriteOutcome<PrReviewSubmitResult>,
): PrReviewAttempt {
  return { kind: "failed", message: "" };
}

export type PrReviewAttemptView = {
  readonly tone: "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
};

export function describePrReviewAttempt(
  _attempt: PrReviewAttempt,
): PrReviewAttemptView | null {
  return null;
}

export function auditFailedNote(_attempt: PrReviewAttempt): string | null {
  return "";
}

export type SubmitControl = {
  readonly disabled: boolean;
  readonly label: string;
};

export function submitControl(_state: {
  readonly locked: boolean;
  readonly waiting: boolean;
}): SubmitControl {
  return { disabled: false, label: "" };
}
