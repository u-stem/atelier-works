import type { PrReviewAttempt } from "../../lib/prReviewOutcome.ts";
import type { PrReviewResultState } from "../../lib/prReviewResult.ts";

export function PrReviewAttemptNotice(_props: { attempt: PrReviewAttempt }) {
  return null;
}

export function PrReviewResultPanel(_props: {
  state: PrReviewResultState;
  flowJobId: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return null;
}

export function PrReviewResult(_props: {
  flowJobId: string;
  onWaitingChange: (waiting: boolean) => void;
}) {
  return null;
}
