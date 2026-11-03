import { type ReactNode, useMemo, useState } from "react";
import type { InboxProposal } from "../../api/guards/inboxProposals.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { useInboxProposals } from "../../api/inboxQueries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { ViewModeSwitch } from "../../components/ViewModeSwitch.tsx";
import {
  factoryLabelChoice,
  previewBlockedReason,
  previewCheckMessage,
  proposalOrigin,
} from "../../lib/approvalDecision.ts";
import { NO_LINGER_OPTIONS } from "../../lib/delayedVisible.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import type { RepoRef } from "../../lib/markdownLink.ts";
import type { ViewMode } from "../../lib/requirementsView.ts";
import { ApprovalBar } from "./ApprovalBar.tsx";
import { IssueBody } from "./IntakeSnapshotPanel.tsx";

/** 切り替えと承認の停止に出す、提案の本文の名前。 */
const PROPOSAL_BODY_TARGET = "提案の本文";

/**
 * 提案の題名と本文を出す。
 * `repo`は、作られるIssueのリポジトリ。プレビューのリンクをこのリポジトリのIssueとPRに絞る。
 * 分からないときは`null`にし、リンクを作らない。
 * 本文は、既定の原文では解釈せずに描き、`mode`がプレビューのときだけ参考に描く。
 * `modeSwitch`は、画面が持つ切り替え。本文の上に置く。
 */
export function ProposalBody({
  proposal,
  repo,
  mode = "text",
  modeSwitch = null,
}: {
  proposal: InboxProposal;
  repo: RepoRef | null;
  /** 本文の表示の形式。省略すると原文になる。 */
  mode?: ViewMode;
  modeSwitch?: ReactNode;
}) {
  const title = displayableIssueText(proposal.proposal_title);
  const body = displayableIssueText(proposal.proposal_body);
  const origin = proposalOrigin(proposal);
  return (
    <Card aria-labelledby="proposal-heading" tag="section">
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
        {modeSwitch}
        <IssueBody source={proposal.proposal_body} mode={mode} repo={repo} />
      </div>
    </Card>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <Card tag="p" variant="empty">
      {children}
    </Card>
  );
}

/** 読み込み中の形。 */
const LOADING_SHAPE: LoadingShape = {
  className: "space-y-2",
  node: (
    <>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </>
  ),
};

/**
 * Issue提案の承認。提案の本文を出し、その下に承認バーを置く。
 * 本文とラベルの選択肢は"inbox"ビューから読む。読めないあいだは承認の操作を出さない。
 * 提案が未決の一覧に無いときも、本文が分からないまま承認させないので、操作を出さない。
 * 本文は原文が既定で、プレビューは参考に切り替えて読める。
 * プレビューを表示している間は承認を止め、一度でも表示した承認は、原文を確かめたかのチェックを求める。
 * `initialMode`は最初の表示の形式で、省略すると原文になる。
 */
export function ProposalReview({
  approval,
  title,
  now,
  initialMode = "text",
}: {
  approval: SummaryApproval;
  title: string;
  now: number;
  initialMode?: ViewMode;
}) {
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [previewed, setPreviewed] = useState<boolean>(
    initialMode === "preview",
  );
  const { owner, repo } = approval;
  // 提案のIssueは、承認依頼と同じ作業項目のリポジトリに作られる。
  const repoRef = useMemo(() => ({ owner, repo }), [owner, repo]);
  const proposals = useInboxProposals();
  // 承認の可否は取得の状態だけで決まる。内容と食い違わないよう、取得が済んだら骨組みを残さず内容を出す。
  const display = useLoadingDisplay(loadPhaseOf(proposals), NO_LINGER_OPTIONS);
  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (proposals.isPending || display !== "content") {
    return <LoadingBody display={display} shape={LOADING_SHAPE} />;
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
      <ProposalBody
        proposal={proposal}
        repo={repoRef}
        mode={mode}
        modeSwitch={
          <ViewModeSwitch
            target={PROPOSAL_BODY_TARGET}
            textLabel="原文"
            mode={mode}
            onChange={(next) => {
              setMode(next);
              setPreviewed(true);
            }}
          />
        }
      />
      <ApprovalBar
        approval={approval}
        now={now}
        subject={displayableIssueText(title).text}
        factoryLabel={factoryLabelChoice(proposal)}
        approveBlockedReason={
          mode === "preview" ? previewBlockedReason(PROPOSAL_BODY_TARGET) : null
        }
        refreshed={false}
        fullCheckRequired={false}
        previewCheckMessage={
          previewed ? previewCheckMessage(PROPOSAL_BODY_TARGET) : null
        }
      />
    </>
  );
}
