// 投入したフローのジョブの結果から、画面に出す状態を決める。

import type { PrReviewRegisterRefusalReason } from "../api/guards/writeResults.ts";
import type { DetailSnapshot } from "../api/jobsQueries.ts";

export type PrReviewResultState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "waiting" }
  | { readonly kind: "started"; readonly workItemId: number }
  | {
      readonly kind: "refused";
      readonly reason: PrReviewRegisterRefusalReason;
    };

export type PrReviewResultInput = {
  readonly output: DetailSnapshot & {
    readonly isError: boolean;
    readonly isPending: boolean;
    readonly isFetching: boolean;
  };
  readonly status: DetailSnapshot;
};

export function prReviewResultState(
  _input: PrReviewResultInput,
): PrReviewResultState {
  return { kind: "unreadable" };
}

export function offersRetry(_state: PrReviewResultState): boolean {
  return true;
}

export type PrReviewResultView = {
  readonly tone: "default" | "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
};

export function describePrReviewResult(
  _state: PrReviewResultState,
): PrReviewResultView {
  return { tone: "default", headline: "", lines: [] };
}
