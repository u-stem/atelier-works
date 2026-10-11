import { useState } from "react";
import { toast } from "sonner";
import type { ApprovalDecideResult } from "../../api/guards/writeResults.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { writeTargetKey } from "../../api/writeLocks.ts";
import { decideApproval } from "../../api/writes.ts";
import {
  approvalOutcomeNotice,
  type ToastNotice,
} from "../../lib/approvalNotice.ts";
import {
  classifyDecisionRefusal,
  type DecisionRefusal,
} from "../../lib/approvalRefusal.ts";
import { STALE_LIST_NOTICE } from "../../lib/writeNotices.ts";

export type DecisionInput = {
  readonly approvalRequestId: number;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly withFactoryLabel: boolean | undefined;
};

function keyOf(input: DecisionInput): string {
  return writeTargetKey("approval", input.approvalRequestId);
}

function run(input: DecisionInput): Promise<ApprovalDecideResult> {
  return decideApproval({
    approvalRequestId: input.approvalRequestId,
    decision: input.decision,
    reason: input.reason,
    ...(input.withFactoryLabel === undefined
      ? {}
      : { withFactoryLabel: input.withFactoryLabel }),
  });
}

function showToast(notice: ToastNotice): void {
  switch (notice.tone) {
    case "success":
      toast.success(notice.message);
      return;
    case "info":
      toast.info(notice.message);
      return;
    case "warning":
      toast.warning(notice.message);
      return;
    case "error":
      toast.error(notice.message);
      return;
  }
}

/**
 * 承認と却下の呼び出しを、ロックと読み直しに載せるフック。
 * scriptが確定して断ったときは、断りの説明を返す。トーストは消えるので、承認バーの中に残して出すためである。
 * `redo`は、承認済みの提案のIssue作成をやり直す呼び出しで、結果の文だけが違う。
 */
export function useApprovalDecision(mode: "decide" | "redo"): {
  readonly submit: (input: DecisionInput) => boolean;
  readonly isLocked: (input: DecisionInput) => boolean;
  readonly refusal: DecisionRefusal | null;
} {
  const [refusal, setRefusal] = useState<DecisionRefusal | null>(null);
  const mutation = useWriteMutation<DecisionInput, ApprovalDecideResult>({
    keyOf,
    run,
    onOutcome: (outcome) => {
      setRefusal(
        outcome.kind === "failed"
          ? classifyDecisionRefusal(outcome.error)
          : null,
      );
      showToast(approvalOutcomeNotice(outcome, mode));
    },
    onStale: () => {
      showToast(STALE_LIST_NOTICE);
    },
  });
  return {
    submit: (input) => {
      setRefusal(null);
      return mutation.submit(input);
    },
    isLocked: mutation.isLocked,
    refusal,
  };
}
