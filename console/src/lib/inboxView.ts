// 要対応の画面の承認待ちの一覧について、並び、絞り込み、行の表示内容を決める純粋関数。

import type { SummaryApproval, SummaryCounts } from "../api/guards/summary.ts";
import { approvalKindLabel, attemptRef, workItemRef } from "./labels.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/** 種類のチップ。「改善提案」は監査から出たIssue提案である。 */
export type InboxChip =
  | "all"
  | "requirements"
  | "issue_proposal"
  | "improvement";

export const INBOX_CHIPS: readonly { id: InboxChip; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "requirements", label: "要件定義" },
  { id: "issue_proposal", label: "Issue化提案" },
  { id: "improvement", label: "改善提案" },
];

/** 承認待ちの1行が属するチップ。`all`は含めない。 */
export function chipOf(approval: SummaryApproval): Exclude<InboxChip, "all"> {
  if (approval.kind === "requirements") {
    return "requirements";
  }
  return approval.origin === "audit" ? "improvement" : "issue_proposal";
}

/** `chip`に当たる行だけを、順序を保って返す。`all`は全件を返す。 */
export function filterApprovals(
  approvals: readonly SummaryApproval[],
  chip: InboxChip,
): SummaryApproval[] {
  return chip === "all"
    ? [...approvals]
    : approvals.filter((approval) => chipOf(approval) === chip);
}

/** チップごとの件数。チップの横に出して、絞り込む前に件数が分かるようにする。 */
export function chipCounts(
  approvals: readonly SummaryApproval[],
): Record<InboxChip, number> {
  const counts: Record<InboxChip, number> = {
    all: approvals.length,
    requirements: 0,
    issue_proposal: 0,
    improvement: 0,
  };
  for (const approval of approvals) {
    counts[chipOf(approval)] += 1;
  }
  return counts;
}

/** 依頼が新しい順に並べた新しい配列を返す。同時刻はidが大きい順にする。 */
export function sortApprovals(
  approvals: readonly SummaryApproval[],
): SummaryApproval[] {
  return [...approvals].sort((a, b) => {
    const byTime = Date.parse(b.requested_at) - Date.parse(a.requested_at);
    return byTime !== 0
      ? byTime
      : b.approval_request_id - a.approval_request_id;
  });
}

/** 選んだidの行を返す。選んでいないとき、または一覧に無いときは`null`。 */
export function findApproval(
  approvals: readonly SummaryApproval[],
  id: number | null,
): SummaryApproval | null {
  if (id === null) {
    return null;
  }
  return (
    approvals.find((approval) => approval.approval_request_id === id) ?? null
  );
}

export type ApprovalDescription = {
  readonly title: string;
  readonly kindLabel: string;
  readonly workItemLabel: string;
  /** 要件定義の試行。要件定義でないときは`null`。 */
  readonly attemptLabel: string | null;
  readonly issueLabel: string | null;
  /** リンクにしてよいIssueのURL。GitHubのIssueの形でなければ`null`。 */
  readonly issueUrl: string | null;
};

/** 一覧の行と詳細の概要に出す内容。画面は生のコードを出さず、この結果だけを描く。 */
export function describeApproval(
  approval: SummaryApproval,
): ApprovalDescription {
  const title =
    approval.kind === "issue_proposal"
      ? (approval.proposal_title ?? approval.title)
      : approval.title;
  return {
    title: title ?? workItemRef(approval.work_item_id),
    kindLabel: approvalKindLabel(approval.kind, approval.origin),
    workItemLabel: workItemRef(approval.work_item_id),
    attemptLabel:
      approval.kind === "requirements" && approval.draft_attempt !== null
        ? attemptRef(approval.draft_attempt)
        : null,
    issueLabel:
      approval.issue_number === null ? null : `Issue #${approval.issue_number}`,
    issueUrl: safeGitHubUrl(approval.issue_url),
  };
}

/**
 * 承認待ち以外の要対応(失敗と通知)の件数を伝える文。無ければ`null`。
 * 承認待ちの一覧にこれらは含まれないので、件数があることだけを知らせる。
 */
export function otherCountsNote(counts: SummaryCounts): string | null {
  const parts: string[] = [];
  if (counts.failures > 0) {
    parts.push(`失敗が${counts.failures}件`);
  }
  if (counts.notices > 0) {
    parts.push(`通知が${counts.notices}件`);
  }
  return parts.length === 0 ? null : `ほかに、${parts.join("、")}あります。`;
}
