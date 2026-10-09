import { ExternalLink } from "lucide-react";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { describeApproval } from "../../lib/inboxView.ts";

/**
 * 選んだ承認の概要。題名、種類、作業項目、Issueへのリンク、依頼の時刻を出す。
 * 本文の表示と承認・却下の操作は持たない。
 */
export function ApprovalOverview({
  approval,
  now,
}: {
  approval: SummaryApproval;
  now: number;
}) {
  const description = describeApproval(approval);
  return (
    <article className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{description.kindLabel}</Badge>
          {description.statusLabel === null ? null : (
            <Badge variant="warning">{description.statusLabel}</Badge>
          )}
        </div>
        <h2 className="text-xl font-semibold">{description.title}</h2>
      </header>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">作業項目</dt>
        <dd>
          {description.workItemLabel}
          {description.attemptLabel === null
            ? null
            : `(${description.attemptLabel})`}
        </dd>
        {description.issueLabel === null ? null : (
          <>
            <dt className="text-muted-foreground">Issue</dt>
            <dd>
              {description.issueUrl === null ? (
                description.issueLabel
              ) : (
                <a
                  href={description.issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {description.issueLabel}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">依頼した時刻</dt>
        <dd>
          <TimeText iso={approval.requested_at} now={now} />
        </dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        本文の表示と、承認・却下の操作は、この画面に追加されます。
      </p>
    </article>
  );
}
