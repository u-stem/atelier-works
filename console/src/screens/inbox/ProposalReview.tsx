import type { ReactNode } from "react";
import type { InboxProposal } from "../../api/guards/inboxProposals.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { useInboxProposals } from "../../api/inboxQueries.ts";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  factoryLabelChoice,
  proposalOrigin,
} from "../../lib/approvalDecision.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import { ApprovalBar } from "./ApprovalBar.tsx";

export function ProposalBody({ proposal }: { proposal: InboxProposal }) {
  const title = displayableIssueText(proposal.proposal_title);
  const body = displayableIssueText(proposal.proposal_body);
  const origin = proposalOrigin(proposal);
  return (
    <section
      aria-labelledby="proposal-heading"
      className="rounded-xl border border-border bg-card"
    >
      <header className="flex flex-col gap-1 border-b border-border px-5 py-3">
        <h3 id="proposal-heading" className="text-lead font-semibold">
          提案内容
        </h3>
        {origin.text === "" ? null : (
          <p className="text-small text-muted-foreground">{origin.text}</p>
        )}
      </header>
      <div className="flex flex-col gap-3 px-5 py-4">
        {title.replaced || body.replaced || origin.replaced ? (
          <p className="text-small text-warning">
            不可視の文字を含みます。見えない文字や、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換えて表示しています。
          </p>
        ) : null}
        <p
          dir="ltr"
          className="text-body font-medium break-words text-foreground [unicode-bidi:isolate]"
        >
          {title.text}
        </p>
        <pre
          dir="ltr"
          className="max-h-96 overflow-auto rounded-lg bg-muted px-4 py-3 font-mono text-small break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
        >
          {proposal.proposal_body === "" ? "(本文は空です)" : body.text}
        </pre>
      </div>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-3 text-small text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Issue提案の承認。提案の本文を出し、その下に承認バーを置く。
 * 本文とラベルの選択肢は"inbox"ビューから読む。読めないあいだは承認の操作を出さない。
 * 提案が未決の一覧に無いときも、本文が分からないまま承認させないので、操作を出さない。
 */
export function ProposalReview({
  approval,
  title,
  now,
}: {
  approval: SummaryApproval;
  title: string;
  now: number;
}) {
  const proposals = useInboxProposals();
  if (proposals.isPending) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">読み込み中</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (proposals.isError) {
    return (
      <QueryFailureAlert
        title="提案の内容を取得できませんでした"
        error={proposals.error}
        onRetry={() => {
          void proposals.refetch();
        }}
      />
    );
  }
  const proposal = proposals.data.find(
    (candidate) =>
      candidate.approval_request_id === approval.approval_request_id,
  );
  if (proposal === undefined) {
    return (
      <Notice>
        この提案の内容を取得できませんでした。すでに処理されたか、取得の上限を超えています。一覧を読み直してください。
      </Notice>
    );
  }
  return (
    <>
      <ProposalBody proposal={proposal} />
      <ApprovalBar
        approval={approval}
        now={now}
        subject={displayableIssueText(title).text}
        factoryLabel={factoryLabelChoice(proposal)}
        approveBlockedReason={null}
        refreshed={false}
        fullCheckRequired={false}
      />
    </>
  );
}
