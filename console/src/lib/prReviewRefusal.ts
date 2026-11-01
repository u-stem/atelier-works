// PRレビューの投入の断りの符号を、日本語の固定文にする。

import type {
  PrReviewRegisterRefusalReason,
  PrReviewSubmitRefusalReason,
} from "../api/guards/writeResults.ts";

export function describePrReviewSubmitRefusal(
  _reason: PrReviewSubmitRefusalReason,
): string {
  return "";
}

export function describePrReviewRegisterRefusal(
  _reason: PrReviewRegisterRefusalReason,
): string {
  return "";
}
