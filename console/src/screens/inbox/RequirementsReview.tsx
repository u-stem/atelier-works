import type { SummaryApproval } from "../../api/guards/summary.ts";
import { useIntakeSnapshot } from "../../api/queries.ts";
import { snapshotReadiness } from "../../lib/approvalDecision.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import { ApprovalBar } from "./ApprovalBar.tsx";
import { IntakeSnapshotPanel } from "./IntakeSnapshotPanel.tsx";

const BLOCKED_REASONS = {
  loading:
    "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
  failed:
    "取り込み時点のIssueを取得できていません。取得し直して内容を確かめるまで承認できません。",
} as const;

/**
 * 要件定義の承認。取り込み時点のIssueのパネルの直下に承認バーを置く。
 * 実装のClaudeが受け取るのはこの内容なので、承認者がそれを見られる状態でだけ承認を押せる。
 * 却下は、内容を見られなくても押せる。
 * パネルと同じ取得(キーが同じ)を読むので、取得は1回で済む。
 */
export function RequirementsReview({
  approval,
  title,
  now,
}: {
  approval: SummaryApproval;
  title: string;
  now: number;
}) {
  const snapshot = useIntakeSnapshot(
    approval.work_item_id,
    approval.approval_request_id,
  );
  const readiness = snapshotReadiness(snapshot);
  return (
    <>
      <IntakeSnapshotPanel
        workItemId={approval.work_item_id}
        approvalRequestId={approval.approval_request_id}
      />
      <ApprovalBar
        approval={approval}
        now={now}
        subject={displayableIssueText(title).text}
        factoryLabel={null}
        approveBlockedReason={
          readiness === "ready" ? null : BLOCKED_REASONS[readiness]
        }
        refreshed={snapshot.data?.refreshed === true}
      />
    </>
  );
}
