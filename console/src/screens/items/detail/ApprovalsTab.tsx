import type { WorkItemDetail } from "../../../api/guards/workItemDetail.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import {
  describeApproval,
  sortApprovalsNewestFirst,
} from "../../../lib/itemDetailView.ts";
import {
  EmptyNote,
  Panel,
  PlainBlock,
  Row,
  TimeLabel,
} from "./DetailParts.tsx";

/**
 * 承認の履歴のタブ。承認依頼を新しい順に並べ、状態、決定者、決定の時刻、理由を出す。
 * 却下の理由は、要件定義の作り直しの経緯を読む手がかりになる。
 */
export function ApprovalsTab({
  detail,
  now,
}: {
  detail: WorkItemDetail;
  now: number;
}) {
  const approvals = sortApprovalsNewestFirst(detail.approvals).map(
    describeApproval,
  );
  return (
    <div className="flex max-w-[47.5rem] flex-col gap-6">
      <Panel
        heading="承認の履歴"
        note="承認依頼ごとに、決めた人と理由を並べます。新しい依頼が先です。"
      >
        {approvals.length === 0 ? (
          <EmptyNote>承認依頼はまだありません。</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-3">
            {approvals.map((approval) => (
              <li
                key={approval.key}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-3">
                  <span className="font-semibold">{approval.kindLabel}</span>
                  {approval.subject === null ? null : (
                    <span className="text-body">{approval.subject}</span>
                  )}
                  <Badge variant={approval.statusVariant}>
                    {approval.statusLabel}
                  </Badge>
                </div>
                <dl className="divide-y divide-border">
                  <Row label="依頼">
                    <TimeLabel iso={approval.requestedAt} now={now} />
                  </Row>
                  {approval.expiresAt === null ? null : (
                    <Row label="期限">
                      <TimeLabel iso={approval.expiresAt} now={now} />
                    </Row>
                  )}
                  <Row label="決定">
                    {approval.decidedAt === null ? (
                      <span className="text-muted-foreground">未決定</span>
                    ) : (
                      <TimeLabel iso={approval.decidedAt} now={now} />
                    )}
                  </Row>
                  <Row label="決定者">
                    {approval.decidedBy === null ? (
                      <span className="text-muted-foreground">
                        {approval.decidedAt === null
                          ? "-"
                          : "記録されていません"}
                      </span>
                    ) : (
                      approval.decidedBy
                    )}
                  </Row>
                  <Row label="理由">
                    {approval.reason === null ? (
                      <span className="text-muted-foreground">
                        記録されていません
                      </span>
                    ) : (
                      <PlainBlock>{approval.reason}</PlainBlock>
                    )}
                  </Row>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
