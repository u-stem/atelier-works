import { ExternalLink, Info } from "lucide-react";
import type { ReactNode } from "react";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import { describeApproval, describeExpiry } from "../../lib/inboxView.ts";
import {
  formatAbsoluteWithRelative,
  formatDeadline,
} from "../../lib/relativeTime.ts";
import { IntakeSnapshotPanel } from "./IntakeSnapshotPanel.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

/**
 * 選んだ承認の概要。題名、種類、作業項目、Issueへのリンク、期限、依頼の時刻を出す。
 * 要件定義の承認では、取り込み時点のIssueの題名と本文も出す。
 * 要件定義の本文と承認・却下の操作は持たない。
 */
export function ApprovalOverview({
  approval,
  now,
}: {
  approval: SummaryApproval;
  now: number;
}) {
  const description = describeApproval(approval);
  const expiry = describeExpiry(approval, now);
  return (
    <article className="flex max-w-[47.5rem] flex-col gap-6 p-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="approval">{description.kindLabel}</Badge>
          {description.statusLabel === null ? null : (
            <Badge variant="warning">{description.statusLabel}</Badge>
          )}
        </div>
        <h2 className="text-display font-semibold tracking-tight text-balance">
          {description.title}
        </h2>
      </header>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        <Row label="作業項目">
          {description.workItemLabel}
          {description.attemptLabel === null
            ? null
            : `(${description.attemptLabel})`}
        </Row>
        {description.issueLabel === null ? null : (
          <Row label="Issue">
            {description.issueUrl === null ? (
              description.issueLabel
            ) : (
              <a
                href={description.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {description.issueLabel}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </Row>
        )}
        {expiry === null || approval.expires_at === null ? null : (
          <Row label="期限">
            <span
              className={cn(
                "tabular-nums",
                expiry.urgent && "font-medium text-warning",
                expiry.expired && "text-failure",
              )}
            >
              {formatDeadline(approval.expires_at, now)}
            </span>
          </Row>
        )}
        <Row label="依頼した時刻">
          <time dateTime={approval.requested_at} className="tabular-nums">
            {formatAbsoluteWithRelative(approval.requested_at, now)}
          </time>
        </Row>
      </dl>
      {approval.kind === "requirements" ? (
        <IntakeSnapshotPanel workItemId={approval.work_item_id} />
      ) : null}
      <p className="flex items-start gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-small text-muted-foreground">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-subtle"
        />
        本文の表示と、承認・却下の操作は準備中です。
      </p>
    </article>
  );
}
