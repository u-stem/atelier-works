import { useState } from "react";
import type { ApprovalDecideResult } from "../../api/guards/writeResults.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { writeTargetKey } from "../../api/writeLocks.ts";
import { decideApproval } from "../../api/writes.ts";
import { announce, announceStaleList } from "../../components/announce.ts";
import { approvalOutcomeNotice } from "../../lib/approvalNotice.ts";
import {
  classifyDecisionRefusal,
  type DecisionRefusal,
} from "../../lib/approvalRefusal.ts";
import { redoCooldowns } from "../../lib/redoCooldown.ts";

export type DecisionInput = {
  readonly approvalRequestId: number;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly withFactoryLabel: boolean | undefined;
  /** 承認依頼の種類。結果の文と断りの案内を、種類に合わせる呼び出しだけが渡す。 */
  readonly kind?: string;
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

/**
 * 承認と却下の呼び出しを、ロックと読み直しに載せるフック。
 * scriptが確定して断ったときは、断りの説明を返す。承認バーは、操作した場所で断りを示すために、それを出す。
 * トーストにも同じ断りを出す。項目が一覧から外れてバーごと消えても、断りが残るためである。
 * `redo`は、承認済みの提案のIssue作成をやり直す呼び出しで、結果の文が違う。
 * やり直しが成功したら、その依頼のボタンを一定時間止める(`redoCooldowns`)。
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
    onOutcome: (outcome, input) => {
      if (mode === "redo" && outcome.kind === "done") {
        redoCooldowns.start(input.approvalRequestId, Date.now());
      }
      setRefusal(
        outcome.kind === "failed"
          ? classifyDecisionRefusal(outcome.error, input.kind)
          : null,
      );
      announce(approvalOutcomeNotice(outcome, mode, input.kind));
    },
    onStale: () => {
      announceStaleList();
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
