// 仮の実装。テストが失敗することを確かめるための値だけを返す。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type { ManualIntakeSubmitResult } from "../api/guards/writeResults.ts";

export type IntakeAttempt =
  | { readonly kind: "idle" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | {
      readonly kind: "unknown";
      readonly message: string;
      readonly resendConfirmed: boolean;
    }
  | { readonly kind: "submitted"; readonly flowJobId: string };

export type IntakeAttemptView = {
  readonly tone: "success" | "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
  readonly flowJobId: string | null;
};

export function attemptFromOutcome(
  _outcome: WriteOutcome<ManualIntakeSubmitResult>,
): IntakeAttempt {
  return { kind: "idle" };
}

export function isSubmitBlocked(_attempt: IntakeAttempt): boolean {
  return false;
}

export function confirmResend(attempt: IntakeAttempt): IntakeAttempt {
  return attempt;
}

export function keepsInput(_attempt: IntakeAttempt): boolean {
  return false;
}

export function describeIntakeAttempt(
  _attempt: IntakeAttempt,
): IntakeAttemptView | null {
  return { tone: "error", headline: "", lines: [], flowJobId: "" };
}
