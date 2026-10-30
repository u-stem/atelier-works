import { type ReactNode, useMemo } from "react";
import type { RequirementsDoc } from "../../api/guards/requirements.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { useIntakeSnapshot, useRequirementsDoc } from "../../api/queries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import {
  LoadingBody,
  type LoadingDisplay,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import {
  approvalLinks,
  type DocReadiness,
  docReadiness,
  requirementsBlockedReason,
  snapshotReadiness,
} from "../../lib/approvalDecision.ts";
import { NO_LINGER_OPTIONS } from "../../lib/delayedVisible.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import { attemptRef } from "../../lib/labels.ts";
import { prepareDoc } from "../../lib/requirementsView.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";
import { RequirementsDocumentView } from "../items/RequirementsDocumentView.tsx";
import { ApprovalBar } from "./ApprovalBar.tsx";
import { IntakeSnapshotPanel } from "./IntakeSnapshotPanel.tsx";
import { LOADING_SHAPE, PanelNote, PanelShell } from "./ReviewPanel.tsx";

/** 承認する試行が特定できないときの面。最新の試行では代えない。 */
function UnidentifiedPanel() {
  return (
    <PanelShell heading="承認対象の要件定義書" link={null}>
      <PanelNote>
        承認する試行が特定できないため、要件定義書を表示できません。最新の試行は、承認する試行と違うことがあるため、代わりには出しません。
      </PanelNote>
    </PanelShell>
  );
}

/**
 * 承認する試行の要件定義書を、取り込み時点のIssueのパネルと並べる面。
 * 本文と図の安全は、要件定義書の画面と同じ部品に任せる。
 */
function DocPanel({
  approval,
  attempt,
  query,
  state,
  display,
}: {
  approval: SummaryApproval;
  attempt: number;
  query: {
    readonly data: RequirementsDoc | null | undefined;
    readonly error: Error | null;
    readonly refetch: () => unknown;
  };
  state: DocReadiness;
  /** 読み込み中の表示。取得が済んでも、骨組みを残す時間の間は`content`にならない。 */
  display: LoadingDisplay;
}) {
  const doc = query.data;
  const prepared = useMemo(
    () => (doc === undefined || doc === null ? null : prepareDoc(doc)),
    [doc],
  );
  const heading = `承認対象の要件定義書(${attemptRef(attempt)})`;
  const link = approvalLinks(approval).requirements;
  let body: ReactNode;
  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (display !== "content") {
    body = <LoadingBody display={display} shape={LOADING_SHAPE} />;
  } else if (state === "failed") {
    body = (
      <div className="p-4">
        <QueryFailure
          title="要件定義書を取得できませんでした"
          loginHint="上のバナーからログインすると、要件定義書を表示します。"
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          compact
        />
      </div>
    );
  } else if (state === "missing") {
    body = <PanelNote>承認する試行の要件定義書が見つかりません。</PanelNote>;
  } else if (state === "mismatch" || doc === undefined || doc === null) {
    body = (
      <PanelNote>
        表示している要件定義書の試行が、承認する試行と違います。
      </PanelNote>
    );
  } else if (prepared === null) {
    body = <PanelNote>要件定義書を表示できません。</PanelNote>;
  } else {
    body = (
      <div className="max-h-[40rem] overflow-y-auto px-5 py-4">
        <RequirementsDocumentView
          doc={doc}
          prepared={prepared}
          latestAttempt={null}
          embedded
        />
      </div>
    );
  }
  return (
    <PanelShell heading={heading} link={link}>
      {body}
    </PanelShell>
  );
}

/**
 * 要件定義の承認。取り込み時点のIssueと、承認する試行の要件定義書を並べ、その直下に承認バーを置く。
 * 実装のClaudeが受け取る入力と、承認の対象の本体の両方を、承認者が見られる状態でだけ承認を押せる。
 * 却下は、内容を見られなくても押せる。
 * 本文が長く切られているときは、GitHubで全文を確かめるまで承認を止める。
 * 承認の試行(`draft_attempt`)が分からないときは、最新の試行で代えず、承認を止める。
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
  return approval.draft_attempt === null ? (
    <ReviewBody
      approval={approval}
      title={title}
      now={now}
      docState="unidentified"
      docPanel={<UnidentifiedPanel />}
    />
  ) : (
    <ReviewWithDoc
      approval={approval}
      attempt={approval.draft_attempt}
      title={title}
      now={now}
    />
  );
}

function ReviewWithDoc({
  approval,
  attempt,
  title,
  now,
}: {
  approval: SummaryApproval;
  attempt: number;
  title: string;
  now: number;
}) {
  const query = useRequirementsDoc(approval.work_item_id, attempt);
  const state = docReadiness({ expectedAttempt: attempt, query });
  const display = useLoadingDisplay(loadPhaseOf(query), NO_LINGER_OPTIONS);
  return (
    <ReviewBody
      approval={approval}
      title={title}
      now={now}
      docState={state}
      docPanel={
        <DocPanel
          approval={approval}
          attempt={attempt}
          query={query}
          state={state}
          display={display}
        />
      }
    />
  );
}

function ReviewBody({
  approval,
  title,
  now,
  docState,
  docPanel,
}: {
  approval: SummaryApproval;
  title: string;
  now: number;
  docState: DocReadiness;
  docPanel: ReactNode;
}) {
  // パネルと同じ取得(キーが同じ)を読むので、取得は1回で済む。
  const snapshot = useIntakeSnapshot(
    approval.work_item_id,
    approval.approval_request_id,
  );
  // 承認の可否は取得の状態だけで決まる。内容と食い違わないよう、取得が済んだら骨組みを残さず内容を出す。
  const snapshotDisplay = useLoadingDisplay(
    loadPhaseOf(snapshot),
    NO_LINGER_OPTIONS,
  );
  return (
    <>
      <IntakeSnapshotPanel
        workItemId={approval.work_item_id}
        approvalRequestId={approval.approval_request_id}
        display={snapshotDisplay}
      />
      {docPanel}
      <ApprovalBar
        approval={approval}
        now={now}
        subject={displayableIssueText(title).text}
        factoryLabel={null}
        approveBlockedReason={requirementsBlockedReason(
          snapshotReadiness(snapshot),
          docState,
        )}
        refreshed={snapshot.data?.refreshed === true}
        fullCheckRequired={snapshot.data?.body_truncated === true}
      />
    </>
  );
}
