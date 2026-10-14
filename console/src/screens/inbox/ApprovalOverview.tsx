import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { approvalLinks } from "../../lib/approvalDecision.ts";
import { cn } from "../../lib/cn.ts";
import { describeApproval, describeExpiry } from "../../lib/inboxView.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import {
  formatAbsoluteWithRelative,
  formatDeadline,
} from "../../lib/relativeTime.ts";
import { ProposalReview } from "./ProposalReview.tsx";
import { RequirementsReview } from "./RequirementsReview.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 選んだ承認の詳細。題名、種類、作業項目、Issueへのリンク、期限、依頼の時刻を出す。
 * 続けて、種類ごとの確認の内容と承認バーを出す。
 * 要件定義は取り込み時点のIssue、Issue提案は提案の本文を、承認バーの直前に置く。
 * 要件定義の本文は、要件定義書の画面へのリンクで開く。
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
  const links = approvalLinks(approval);
  const title = displayableIssueText(description.title).text;
  return (
    <article className="flex max-w-[47.5rem] flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="approval">{description.kindLabel}</Badge>
          {description.statusLabel === null ? null : (
            <Badge variant="warning">{description.statusLabel}</Badge>
          )}
        </div>
        <h2
          dir="ltr"
          className="text-display font-semibold tracking-tight text-balance [unicode-bidi:isolate]"
        >
          {title}
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
                className={LINK_CLASS}
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
        {links.requirements === null ? null : (
          <Row label="要件定義書">
            <Link to={links.requirements} className={LINK_CLASS}>
              要件定義書を開く
            </Link>
          </Row>
        )}
        {links.auditReport === null ? null : (
          <Row label="監査レポート">
            <Link to={links.auditReport} className={LINK_CLASS}>
              元の監査レポートを開く
            </Link>
          </Row>
        )}
        <Row label="依頼した時刻">
          <time dateTime={approval.requested_at} className="tabular-nums">
            {formatAbsoluteWithRelative(approval.requested_at, now)}
          </time>
        </Row>
      </dl>
      {approval.kind === "requirements" ? (
        <RequirementsReview approval={approval} title={title} now={now} />
      ) : approval.kind === "issue_proposal" ? (
        <ProposalReview approval={approval} title={title} now={now} />
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-small text-muted-foreground">
          この種類の承認は、この画面では操作できません。
        </p>
      )}
    </article>
  );
}
