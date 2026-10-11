import { useState } from "react";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { redoConfirmation } from "../../lib/approvalDecision.ts";
import { RefusalNotice } from "./RefusalNotice.tsx";
import { useApprovalDecision } from "./useApprovalDecision.ts";

/**
 * 承認済みでIssueをまだ作っていないIssue提案の、Issue作成のやり直し。
 * 承認は記録済みで、サーバーは同じ決定をもう一度受けると、記録済みの選択のまま起票だけをやり直す。
 * ラベルの選択肢は出さない。押しても結果が変わらないためである。
 * 承認の直後は起票の処理が走っている間に押せてしまうので、確認ダイアログで直後に押さないよう促す。
 */
export function IssueRedoBar({
  approval,
  subject,
}: {
  approval: SummaryApproval;
  subject: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const decision = useApprovalDecision("redo");
  const input = {
    approvalRequestId: approval.approval_request_id,
    decision: "approve",
    reason: "",
    withFactoryLabel: undefined,
  } as const;
  const locked = decision.isLocked(input);
  const confirmation = redoConfirmation({
    subject,
    approvalRequestId: approval.approval_request_id,
  });

  return (
    <section
      aria-label="Issue作成のやり直し"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-5 py-4"
    >
      <h3 className="text-lead font-semibold">Issueの作成をやり直す</h3>
      <p className="text-small text-muted-foreground">
        承認は記録済みですが、Issueがまだ作られていません。起票の処理に数分かかることがあるため、承認の直後は押さないでください。
      </p>
      {decision.refusal === null ? null : (
        <RefusalNotice refusal={decision.refusal} />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={locked}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Issueの作成をやり直す
        </Button>
        {locked ? (
          <span role="status" className="text-small text-muted-foreground">
            処理中です。
          </span>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Issueの作成をやり直しますか"
        confirmLabel="やり直す"
        busy={locked}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          decision.submit(input);
        }}
      >
        <p className="font-medium break-words [unicode-bidi:isolate]" dir="ltr">
          {confirmation.subject}
        </p>
        <p className="text-small text-muted-foreground">
          {confirmation.idLabel}
        </p>
        {confirmation.notes.map((note) => (
          <p key={note} className="text-small text-warning">
            {note}
          </p>
        ))}
      </ConfirmDialog>
    </section>
  );
}
