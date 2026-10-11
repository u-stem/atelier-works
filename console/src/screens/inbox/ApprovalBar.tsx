import { TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import {
  approvalConfirmation,
  approveGateProblem,
  decisionSurface,
  EXPIRED_MESSAGE,
  isDecidable,
  reasonCounter,
  rejectConfirmation,
  rejectProblem,
  waitingMessage,
  withFactoryLabelArg,
} from "../../lib/approvalDecision.ts";
import { cn } from "../../lib/cn.ts";
import { IssueRedoBar } from "./IssueRedoBar.tsx";
import { RefusalNotice } from "./RefusalNotice.tsx";
import {
  type DecisionInput,
  useApprovalDecision,
} from "./useApprovalDecision.ts";

/** Issue提案の承認で、作るIssueにfactoryラベルを付けるかの選択肢。 */
type FactoryLabelOption = {
  readonly offered: boolean;
  readonly initial: boolean;
};

type BarProps = {
  approval: SummaryApproval;
  now: number;
  /** 確認ダイアログに出す件名。Issueに由来する文字は、隠れた文字を置き換えてから渡す。 */
  subject: string;
  /** Issue提案のとき、ラベルの選択肢。他の種類は`null`。 */
  factoryLabel: FactoryLabelOption | null;
  /** 承認だけを止める理由。取り込み時点のIssueを見られないときなど。却下は止めない。 */
  approveBlockedReason: string | null;
  /** 取り込み後にIssueが書き換えられていたか。承認を押す位置で、確かめるよう促す。 */
  refreshed: boolean;
  /** 本文が長く、GitHubで全文を確かめるまで承認を止めるか。 */
  fullCheckRequired: boolean;
};

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-3 text-small text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * 詳細に出す操作の面を、依頼の状態で振り分ける。
 * 承認待ちで期限内なら承認と却下、承認済みでIssueが未作成のIssue提案ならIssue作成のやり直し、
 * 期限切れや承認済みには、操作を出さず状況の文だけを出す。
 */
export function ApprovalBar(props: BarProps) {
  const { approval, now, subject } = props;
  switch (decisionSurface(approval, now)) {
    case "decide":
      return <DecideBar {...props} />;
    case "redo_issue":
      return <IssueRedoBar approval={approval} subject={subject} now={now} />;
    case "expired":
      return <Note>{EXPIRED_MESSAGE}</Note>;
    case "waiting":
      return <Note>{waitingMessage(approval.kind)}</Note>;
    case "none":
      return null;
  }
}

/**
 * 承認と却下の操作。
 * 承認はClaudeの実装を起動し取り消せないので、確認ダイアログを経る。
 * 要件定義の却下は作り直しになるので、軽い確認を経る。他の却下は確認なしで、理由を必須にする。
 * 理由は入力欄で長さを知らせる。
 * 確認ダイアログで押した時点で、期限と前提を確かめ直し、満たさなければ送らない。
 * 対象の依頼ごとにボタンをロックし、二重に押しても記録は1回になる。
 */
function DecideBar({
  approval,
  now,
  subject,
  factoryLabel,
  approveBlockedReason,
  refreshed,
  fullCheckRequired,
}: BarProps) {
  const [reason, setReason] = useState("");
  const [labelChecked, setLabelChecked] = useState(
    factoryLabel?.initial ?? false,
  );
  const [fullChecked, setFullChecked] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(
    null,
  );
  const [stopped, setStopped] = useState<string | null>(null);
  const reasonId = useId();
  const decision = useApprovalDecision("decide");

  const withFactoryLabel = withFactoryLabelArg(
    approval.kind,
    factoryLabel?.offered ?? false,
    labelChecked,
  );
  const input = (kind: "approve" | "reject"): DecisionInput => ({
    approvalRequestId: approval.approval_request_id,
    decision: kind,
    reason: kind === "reject" ? reason : "",
    withFactoryLabel,
  });
  const locked = decision.isLocked(input("approve"));
  const counter = reasonCounter(reason);
  const problem = rejectProblem(reason);
  const gate = (nowMs: number): string | null =>
    approveGateProblem({
      approval,
      nowMs,
      blockedReason: approveBlockedReason,
      fullCheckRequired,
      fullChecked,
    });
  const approveProblem = gate(now);
  const approveConfirmation = approvalConfirmation({
    kind: approval.kind,
    subject,
    approvalRequestId: approval.approval_request_id,
    withFactoryLabel,
  });
  const rejectConfirm = rejectConfirmation({
    kind: approval.kind,
    subject,
    approvalRequestId: approval.approval_request_id,
  });

  const rejectNow = (): void => {
    if (rejectProblem(reason) !== null) {
      return;
    }
    if (!isDecidable(approval, Date.now())) {
      setStopped("期限を過ぎたため、却下できませんでした。");
      return;
    }
    setStopped(null);
    decision.submit(input("reject"));
  };
  const dialog =
    confirming === "reject" && rejectConfirm !== null
      ? {
          title: "この依頼を却下しますか",
          confirmLabel: "却下する",
          destructive: true,
          body: (
            <p className="text-small text-warning">
              {rejectConfirm.consequence}
            </p>
          ),
          subject: rejectConfirm.subject,
          idLabel: rejectConfirm.idLabel,
        }
      : {
          title: "この依頼を承認しますか",
          confirmLabel: "承認する",
          destructive: false,
          body: (
            <p className="text-small text-warning">
              {approveConfirmation.consequence}
            </p>
          ),
          subject: approveConfirmation.subject,
          idLabel: approveConfirmation.idLabel,
        };

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
      {fullCheckRequired ? (
        <label className="flex items-start gap-2 text-body">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={fullChecked}
            disabled={locked}
            onChange={(event) => {
              setFullChecked(event.target.checked);
            }}
          />
          本文が長く、上には先頭だけを表示しています。GitHubで全文を確かめました
        </label>
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
      {approveProblem === null ? null : (
        <p className="text-small text-warning">{approveProblem}</p>
      )}
      {stopped === null ? null : (
        <p role="alert" className="text-small font-medium text-failure">
          {stopped}
        </p>
      )}
      {decision.refusal === null ? null : (
        <RefusalNotice refusal={decision.refusal} />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={locked || approveProblem !== null}
          onClick={() => {
            setStopped(null);
            setConfirming("approve");
          }}
        >
          承認する
        </Button>
        <Button
          variant="destructive"
          disabled={locked || problem !== null}
          onClick={() => {
            if (rejectConfirm === null) {
              rejectNow();
            } else {
              setStopped(null);
              setConfirming("reject");
            }
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
        open={confirming !== null}
        title={dialog.title}
        confirmLabel={dialog.confirmLabel}
        destructive={dialog.destructive}
        busy={locked}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          const kind = confirming;
          setConfirming(null);
          if (kind === "reject") {
            rejectNow();
            return;
          }
          const stop = gate(Date.now());
          if (stop !== null) {
            setStopped(stop);
            return;
          }
          setStopped(null);
          decision.submit(input("approve"));
        }}
      >
        <p className="font-medium break-words [unicode-bidi:isolate]" dir="ltr">
          {dialog.subject}
        </p>
        <p className="text-small text-muted-foreground">{dialog.idLabel}</p>
        {dialog.body}
      </ConfirmDialog>
    </section>
  );
}
