import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import type { ApprovalDecideResult } from "../../api/guards/writeResults.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { writeTargetKey } from "../../api/writeLocks.ts";
import { decideApproval } from "../../api/writes.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import {
  approvalConfirmation,
  isDecidable,
  reasonCounter,
  rejectProblem,
  withFactoryLabelArg,
} from "../../lib/approvalDecision.ts";
import {
  approvalOutcomeNotice,
  type ToastNotice,
} from "../../lib/approvalNotice.ts";
import { cn } from "../../lib/cn.ts";
import { STALE_LIST_NOTICE } from "../../lib/writeNotices.ts";

type DecisionInput = {
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

/** Issue提案の承認で、作るIssueにfactoryラベルを付けるかの選択肢。 */
type FactoryLabelOption = {
  readonly offered: boolean;
  readonly initial: boolean;
};

/**
 * 承認と却下の操作。承認待ちで期限内の依頼にだけ出す。
 * 承認はClaudeの実装を起動し取り消せないので、確認ダイアログを経る。
 * 却下は理由が必須で、入力欄で長さを知らせる。
 * 対象の依頼ごとにボタンをロックし、二重に押しても記録は1回になる。
 * `approveBlockedReason`があるときは、承認だけを止め、その理由を添える。却下は止めない。
 */
export function ApprovalBar({
  approval,
  now,
  subject,
  factoryLabel,
  approveBlockedReason,
  refreshed,
}: {
  approval: SummaryApproval;
  now: number;
  /** 確認ダイアログに出す件名。Issueに由来する文字は、隠れた文字を置き換えてから渡す。 */
  subject: string;
  /** Issue提案のとき、ラベルの選択肢。他の種類は`null`。 */
  factoryLabel: FactoryLabelOption | null;
  approveBlockedReason: string | null;
  /** 取り込み後にIssueが書き換えられていたか。承認を押す位置で、確かめるよう促す。 */
  refreshed: boolean;
}) {
  const [reason, setReason] = useState("");
  const [labelChecked, setLabelChecked] = useState(
    factoryLabel?.initial ?? false,
  );
  const [confirming, setConfirming] = useState(false);
  const reasonId = useId();
  const mutation = useWriteMutation<DecisionInput, ApprovalDecideResult>({
    keyOf,
    run,
    onOutcome: (outcome) => {
      showToast(approvalOutcomeNotice(outcome));
    },
    onStale: () => {
      showToast(STALE_LIST_NOTICE);
    },
  });

  if (!isDecidable(approval, now)) {
    return approval.status === "pending" ? (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-small text-muted-foreground">
        期限を過ぎているため、承認も却下もできません。
      </p>
    ) : null;
  }

  const withFactoryLabel = withFactoryLabelArg(
    approval.kind,
    factoryLabel?.offered ?? false,
    labelChecked,
  );
  const input = (decision: "approve" | "reject"): DecisionInput => ({
    approvalRequestId: approval.approval_request_id,
    decision,
    reason: decision === "reject" ? reason : "",
    withFactoryLabel,
  });
  const locked = mutation.isLocked(input("approve"));
  const counter = reasonCounter(reason);
  const problem = rejectProblem(reason);
  const confirmation = approvalConfirmation({
    kind: approval.kind,
    subject,
    approvalRequestId: approval.approval_request_id,
    withFactoryLabel,
  });

  return (
    <section
      aria-label="承認バー"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-5 py-4"
    >
      <h3 className="text-lead font-semibold">承認と却下</h3>
      {refreshed ? (
        <p className="flex items-start gap-2 text-small font-medium text-warning">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          取り込み後にIssueが書き換えられています。上の内容を確かめてから承認してください。
        </p>
      ) : null}
      {factoryLabel === null ? null : factoryLabel.offered ? (
        <label className="flex items-center gap-2 text-body">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={labelChecked}
            disabled={locked}
            onChange={(event) => {
              setLabelChecked(event.target.checked);
            }}
          />
          起票と同時にfactoryラベルを付けて要件定義に進める
        </label>
      ) : (
        <p className="text-small text-muted-foreground">
          factoryラベルを付けられないため、起票のみ行います。
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={reasonId} className="text-small font-medium">
          却下の理由(却下するときは必須)
        </label>
        <Textarea
          id={reasonId}
          rows={3}
          value={reason}
          disabled={locked}
          aria-invalid={counter.over}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-caption">
          <span
            className={counter.over ? "text-failure" : "text-muted-foreground"}
          >
            {problem ?? ""}
          </span>
          <span
            className={cn(
              "tabular-nums",
              counter.over ? "font-medium text-failure" : "text-subtle",
            )}
          >
            {counter.label}
          </span>
        </div>
      </div>
      {approveBlockedReason === null ? null : (
        <p className="text-small text-warning">{approveBlockedReason}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={locked || approveBlockedReason !== null}
          onClick={() => {
            setConfirming(true);
          }}
        >
          承認する
        </Button>
        <Button
          variant="destructive"
          disabled={locked || problem !== null}
          onClick={() => {
            mutation.submit(input("reject"));
          }}
        >
          却下する
        </Button>
        {locked ? (
          <span role="status" className="text-small text-muted-foreground">
            処理中です。
          </span>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title="この依頼を承認しますか"
        confirmLabel="承認する"
        busy={locked}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          mutation.submit(input("approve"));
        }}
      >
        <p className="font-medium break-words [unicode-bidi:isolate]" dir="ltr">
          {confirmation.subject}
        </p>
        <p className="text-small text-muted-foreground">
          {confirmation.idLabel}
        </p>
        <p className="text-small text-warning">{confirmation.consequence}</p>
      </ConfirmDialog>
    </section>
  );
}
