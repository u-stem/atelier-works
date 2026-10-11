// 作業項目の詳細の画面が使う、表示用の純関数。
// 画面は生のコードや英語のフィールド名を出さず、この結果だけを描く。
// Issueの起票者や実行ログに由来する文字は、見えない文字を置き換えてから文字として出す。

import type {
  WorkItemApproval,
  WorkItemAttempt,
  WorkItemDiffStat,
  WorkItemFixRound,
  WorkItemOverview,
  WorkItemReview,
  WorkItemRound,
} from "../api/guards/workItemDetail.ts";
import type { WorkItemFailure } from "../api/guards/workItemFailures.ts";
import type { WorkItemTransition } from "../api/guards/workItemTransitions.ts";
import { displayableIssueText } from "./intakeText.ts";
import { isJobId } from "./jobLink.ts";
import {
  approvalKindLabel,
  approvalStatusLabel,
  attemptRef,
  workItemKindLabel,
  workItemRef,
} from "./labels.ts";
import {
  type PipelineStatusVariant,
  pipelineStatusLabel,
  pipelineStatusVariant,
  prLink,
} from "./pipelineView.ts";
import { requirementsPath } from "./requirementsView.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

function plain(text: string): string {
  return displayableIssueText(text).text;
}

function plainOrNull(text: string | null): string | null {
  if (text === null) return null;
  const shown = plain(text);
  return shown.trim() === "" ? null : shown;
}

// ---------------------------------------------------------------------------
// タブ
// ---------------------------------------------------------------------------

export type ItemDetailTabId =
  | "overview"
  | "requirements"
  | "rounds"
  | "approvals";

export const ITEM_DETAIL_TABS: readonly {
  readonly id: ItemDetailTabId;
  readonly label: string;
}[] = [
  { id: "overview", label: "概要" },
  { id: "requirements", label: "要件定義" },
  { id: "rounds", label: "ラウンド" },
  { id: "approvals", label: "承認の履歴" },
];

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は概要にする。 */
export function parseDetailTab(value: string | null): ItemDetailTabId {
  return ITEM_DETAIL_TABS.find((tab) => tab.id === value)?.id ?? "overview";
}

/**
 * タブの並びでキーを押したときに移る先の位置。端では反対側へ回る。
 * 矢印とHomeとEnd以外のキーは`null`にして、既定の動作に任せる。
 */
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * キー操作に修飾キーが付いているか。
 * Alt+矢印(戻る・進む)やCtrl+Homeなどのブラウザの操作を、タブの移動で奪わないために使う。
 */
export function hasModifierKey(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

// ---------------------------------------------------------------------------
// 件数の上限
// ---------------------------------------------------------------------------

/**
 * `work_item_detail`が1つの履歴に載せる件数の上限。新しい順に切る。
 * `console_query`の`DETAIL_FAILURE_LIMIT`、`DETAIL_TRANSITION_LIMIT`、`DETAIL_LIST_LIMIT`に合わせる。
 */
export const DETAIL_LIMITS = {
  failures: 20,
  transitions: 100,
  reviews: 50,
  fixRounds: 50,
} as const;

/**
 * 履歴の件数が上限に届いたときの注記。届いていなければ`null`。
 * 上限に届いた履歴は、古い記録がbackendで切られている可能性がある。
 */
export function detailLimitNote(count: number, limit: number): string | null {
  return count >= limit
    ? `新しい順に${limit}件まで表示しています。それより古い記録は表示していません。`
    : null;
}

// ---------------------------------------------------------------------------
// 概要
// ---------------------------------------------------------------------------

/** 「Issue #9」や「PR #12」。`url`はGitHubのIssueかPRのURLの形のときだけ持ち、そうでなければ`null`。 */
export type TargetLink = {
  readonly label: string;
  readonly url: string | null;
};

export type OverviewView = {
  readonly title: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly statusVariant: PipelineStatusVariant;
  readonly statusNote: string | null;
  readonly repoLabel: string;
  readonly issue: TargetLink | null;
  readonly pr: TargetLink | null;
  readonly branch: string | null;
  readonly attempt: number;
  readonly fixRound: number;
  readonly costLabel: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

function issueTarget(item: WorkItemOverview): TargetLink | null {
  return item.issue_number === null
    ? null
    : {
        label: `Issue #${item.issue_number}`,
        url: safeGitHubUrl(item.issue_url),
      };
}

/** 記録されたURLが使えなければ、番号から組み立てる。owner・repoも検査を通してから使う。 */
function pullTarget(item: WorkItemOverview): TargetLink | null {
  const recorded = prLink(item.pr_url);
  if (recorded !== null) return recorded;
  if (item.pr_number === null) return null;
  return {
    label: `PR #${item.pr_number}`,
    url: safeGitHubUrl(
      `https://github.com/${item.owner}/${item.repo}/pull/${item.pr_number}`,
    ),
  };
}

function overviewTitle(item: WorkItemOverview): string {
  const title = plainOrNull(item.title);
  if (title !== null) return title;
  return item.issue_number === null
    ? workItemRef(item.work_item_id)
    : `Issue #${item.issue_number}`;
}

/** 費用の表示。0.01ドル未満の正の費用は、0に見えないよう「未満」で示す。 */
export function formatCostUsd(cost: number | null): string {
  if (cost === null) return "記録なし";
  if (cost > 0 && cost < 0.01) return "$0.01未満";
  return `$${cost.toFixed(2)}`;
}

/** 差分の規模の表示。符号ではなく言葉で書く。記録が無ければ`null`。 */
export function formatDiffStat(stat: WorkItemDiffStat | null): string | null {
  return stat === null
    ? null
    : `${stat.files}ファイル・追加${stat.added}行・削除${stat.deleted}行`;
}

/**
 * 状態の注記。注記が「PR」「Issue」の行に出るリンクのURLだけなら`null`にする。
 * 同じリンクが行に出ており、生の文字で重ねる必要がないためである。
 * 行に出ていないURLは、検査を通らなかった値も含めて残す。
 */
function statusNoteOf(item: WorkItemOverview): string | null {
  const note = plainOrNull(item.status_note);
  if (note === null) return null;
  const shown = [issueTarget(item)?.url, pullTarget(item)?.url];
  return shown.includes(note.trim()) ? null : note;
}

export function describeOverview(item: WorkItemOverview): OverviewView {
  return {
    title: overviewTitle(item),
    kindLabel: workItemKindLabel(item.kind),
    statusLabel: pipelineStatusLabel(item.status),
    statusVariant: pipelineStatusVariant(item.status),
    statusNote: statusNoteOf(item),
    repoLabel: `${item.owner}/${item.repo}`,
    issue: issueTarget(item),
    pr: pullTarget(item),
    branch: plainOrNull(item.branch),
    attempt: item.attempt,
    fixRound: item.fix_round,
    costLabel:
      item.total_cost_usd === null
        ? formatCostUsd(null)
        : `${formatCostUsd(item.total_cost_usd)}(${item.run_count}回の実行)`,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 要件定義の試行
// ---------------------------------------------------------------------------

export type AttemptView = {
  readonly attempt: number;
  readonly attemptLabel: string;
  readonly summary: string;
  readonly createdAt: string;
  /** 承認依頼があるときの状態の名前。無ければ`null`。 */
  readonly approvalLabel: string | null;
  readonly approvalVariant: PipelineStatusVariant;
  /** 要件定義書の画面への経路。最新の試行は試行の番号を付けず、常に最新を指す。 */
  readonly path: string;
  /** 経路のリンクの文言。どの試行の書類を開くかを添える。 */
  readonly linkLabel: string;
};

/** `isLatest`は、作業項目の試行のうち最新のものかどうか。 */
export function describeAttempt(
  workItemId: number,
  attempt: WorkItemAttempt,
  isLatest: boolean,
): AttemptView {
  const label = attemptRef(attempt.attempt);
  return {
    attempt: attempt.attempt,
    attemptLabel: label,
    summary: plain(attempt.summary),
    createdAt: attempt.created_at,
    approvalLabel:
      attempt.approval_status === null
        ? null
        : approvalStatusLabel(attempt.approval_status, "requirements"),
    approvalVariant: approvalVariant(attempt.approval_status),
    path: requirementsPath(workItemId, isLatest ? null : attempt.attempt),
    linkLabel: isLatest
      ? `要件定義書を開く(${label}・最新)`
      : `要件定義書を開く(${label})`,
  };
}

// ---------------------------------------------------------------------------
// 承認の履歴
// ---------------------------------------------------------------------------

function approvalVariant(status: string | null): PipelineStatusVariant {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "rejected":
      return "failure";
    default:
      return "muted";
  }
}

export type ApprovalView = {
  readonly key: number;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly statusVariant: PipelineStatusVariant;
  /** 要件定義なら対象の試行、Issue提案なら提案の題名。どちらも無ければ`null`。 */
  readonly subject: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  /** 却下などの理由。空白だけなら`null`。 */
  readonly reason: string | null;
};

function approvalSubject(approval: WorkItemApproval): string | null {
  if (approval.kind === "requirements") {
    return approval.draft_attempt === null
      ? null
      : attemptRef(approval.draft_attempt);
  }
  return plainOrNull(approval.proposal_title);
}

export function describeApproval(approval: WorkItemApproval): ApprovalView {
  return {
    key: approval.approval_request_id,
    kindLabel: approvalKindLabel(approval.kind, null),
    statusLabel: approvalStatusLabel(approval.status, approval.kind),
    statusVariant: approvalVariant(approval.status),
    subject: approvalSubject(approval),
    requestedAt: approval.requested_at,
    expiresAt: approval.expires_at,
    decidedAt: approval.decided_at,
    decidedBy: plainOrNull(approval.decided_by),
    reason: plainOrNull(approval.reason),
  };
}

/**
 * 承認依頼を依頼が新しい順に並べた新しい配列を返す。同じ時刻は番号が大きい方を先にする。
 * 並べ方はbackendの`ORDER BY requested_at DESC, id DESC`と同じである。
 * 画面の順序がbackendの問い合わせの並びに左右されないよう、画面側でも並べる。
 */
export function sortApprovalsNewestFirst(
  approvals: readonly WorkItemApproval[],
): WorkItemApproval[] {
  return [...approvals].sort(
    (a, b) =>
      Date.parse(b.requested_at) - Date.parse(a.requested_at) ||
      b.approval_request_id - a.approval_request_id,
  );
}

// ---------------------------------------------------------------------------
// ラウンド
// ---------------------------------------------------------------------------

function unknownLabel(value: string): string {
  return `不明(${plain(value)})`;
}

const ROUND_MODE_LABELS: ReadonlyMap<string, string> = new Map([
  ["implement", "実装"],
  ["fix", "検査の修正"],
]);

const ROUND_OUTCOME_LABELS: ReadonlyMap<string, string> = new Map([
  ["done", "完了"],
  ["requirements_gap", "要件の不足"],
  ["check_failed", "検査の失敗"],
  ["checks_skipped", "検査の省略"],
  ["stalled", "進展なし"],
  ["error", "エラー"],
]);

const ROUND_OUTCOME_VARIANTS: ReadonlyMap<string, PipelineStatusVariant> =
  new Map([
    ["done", "success"],
    ["requirements_gap", "warning"],
    ["check_failed", "failure"],
    ["checks_skipped", "warning"],
    ["stalled", "warning"],
    ["error", "failure"],
  ]);

export type RoundGroup = {
  readonly attempt: number;
  readonly rounds: WorkItemRound[];
};

/** 実装のラウンドを試行ごとにまとめる。試行は新しい方を先に、ラウンドは古い順に並べる。 */
export function groupRoundsByAttempt(
  rounds: readonly WorkItemRound[],
): RoundGroup[] {
  const byAttempt = new Map<number, WorkItemRound[]>();
  for (const round of rounds) {
    const group = byAttempt.get(round.attempt);
    if (group === undefined) {
      byAttempt.set(round.attempt, [round]);
    } else {
      group.push(round);
    }
  }
  return [...byAttempt.entries()]
    .sort(([a], [b]) => b - a)
    .map(([attempt, group]) => ({
      attempt,
      rounds: group.sort((a, b) => a.round - b.round),
    }));
}

export type RoundView = {
  readonly key: number;
  readonly roundLabel: string;
  readonly modeLabel: string;
  readonly outcomeLabel: string;
  readonly outcomeVariant: PipelineStatusVariant;
  readonly summary: string;
  readonly gapReport: string | null;
  readonly skippedReason: string | null;
  readonly protectedChanges: string[];
  readonly diffLabel: string | null;
  readonly createdAt: string;
};

export function describeRound(round: WorkItemRound): RoundView {
  return {
    key: round.round_id,
    roundLabel: `ラウンド ${round.round}`,
    modeLabel: ROUND_MODE_LABELS.get(round.mode) ?? unknownLabel(round.mode),
    outcomeLabel:
      ROUND_OUTCOME_LABELS.get(round.outcome) ?? unknownLabel(round.outcome),
    outcomeVariant: ROUND_OUTCOME_VARIANTS.get(round.outcome) ?? "muted",
    summary: plain(round.summary),
    gapReport: plainOrNull(round.gap_report),
    skippedReason: plainOrNull(round.checks_skipped_reason),
    protectedChanges: round.protected_changes.map(plain),
    diffLabel: formatDiffStat(round.diff_stat),
    createdAt: round.created_at,
  };
}

const VERDICT_LABELS: ReadonlyMap<string, string> = new Map([
  ["approve", "承認"],
  ["comment", "コメント"],
  ["request_changes", "修正を依頼"],
]);

const VERDICT_VARIANTS: ReadonlyMap<string, PipelineStatusVariant> = new Map([
  ["approve", "success"],
  ["request_changes", "warning"],
]);

/** コミットの表示に使う先頭の桁数。 */
const SHORT_SHA_LENGTH = 7;

export type ReviewView = {
  readonly key: number;
  readonly shaLabel: string;
  readonly verdictLabel: string;
  readonly verdictVariant: PipelineStatusVariant;
  readonly findingLabel: string;
  readonly createdAt: string;
};

export function describeReview(review: WorkItemReview): ReviewView {
  return {
    key: review.review_id,
    shaLabel: plain(review.head_sha).slice(0, SHORT_SHA_LENGTH),
    verdictLabel:
      VERDICT_LABELS.get(review.verdict) ?? unknownLabel(review.verdict),
    verdictVariant: VERDICT_VARIANTS.get(review.verdict) ?? "muted",
    findingLabel: `指摘 ${review.finding_count}件`,
    createdAt: review.created_at,
  };
}

const FIX_OUTCOME_LABELS: ReadonlyMap<string, string> = new Map([
  ["done", "完了"],
  ["requirements_gap", "要件の不足"],
  ["blocked", "ブロック"],
]);

const FIX_OUTCOME_VARIANTS: ReadonlyMap<string, PipelineStatusVariant> =
  new Map([
    ["done", "success"],
    ["requirements_gap", "warning"],
    ["blocked", "failure"],
  ]);

export type FixRoundView = {
  readonly key: number;
  readonly roundLabel: string;
  readonly outcomeLabel: string;
  readonly outcomeVariant: PipelineStatusVariant;
  readonly countsLabel: string;
  readonly createdAt: string;
};

export function describeFixRound(fixRound: WorkItemFixRound): FixRoundView {
  return {
    key: fixRound.fix_round_id,
    roundLabel: `修正 ${fixRound.round}`,
    outcomeLabel:
      FIX_OUTCOME_LABELS.get(fixRound.outcome) ??
      unknownLabel(fixRound.outcome),
    outcomeVariant: FIX_OUTCOME_VARIANTS.get(fixRound.outcome) ?? "muted",
    countsLabel: `対象のレビュー ${fixRound.trigger_review_count}件・返信 ${fixRound.reply_count}件・コミット ${fixRound.commit_count}件`,
    createdAt: fixRound.created_at,
  };
}

// ---------------------------------------------------------------------------
// 状態の遷移と失敗
// ---------------------------------------------------------------------------

export type JobLinkView = { readonly label: string; readonly jobId: string };

type JobLinkLabels = {
  /** `jobId`のリンクの文言。 */
  readonly job: string;
  /** `rootJobId`のリンクの文言。 */
  readonly root: string;
  /** 2つが同じジョブのときに出す1つのリンクの文言。 */
  readonly same: string;
};

/** 遷移の`job_id`は遷移を起こしたステップのジョブ、`root_job_id`はそのステップを含むフローのジョブである。 */
const TRANSITION_JOB_LABELS: JobLinkLabels = {
  job: "ステップのジョブ",
  root: "フローのジョブ",
  same: "ジョブ",
};

/**
 * 失敗の`job_id`は失敗の記録に渡されたジョブで、フローの失敗ではフローのルート、ステップの中の記録ではそのステップである。
 * `root_job_id`は、失敗を記録したジョブのルートジョブである。遷移とは意味が違うので、文言を分ける。
 */
const FAILURE_JOB_LABELS: JobLinkLabels = {
  job: "失敗したジョブ",
  root: "記録したジョブのフロー",
  same: "失敗したジョブ",
};

/**
 * ジョブのリンクを決める。同じジョブなら1つだけ出し、片方しか無ければその1つを出す。
 * UUIDの形でないIDは出さない。文言は`labels`で、`jobId`と`rootJobId`の意味に合わせる。
 */
function jobLinks(
  jobId: string | null,
  rootJobId: string | null,
  labels: JobLinkLabels,
): JobLinkView[] {
  const step = isJobId(jobId) ? jobId : null;
  const root = isJobId(rootJobId) ? rootJobId : null;
  if (step !== null && root !== null) {
    return step.toLowerCase() === root.toLowerCase()
      ? [{ label: labels.same, jobId: step }]
      : [
          { label: labels.job, jobId: step },
          { label: labels.root, jobId: root },
        ];
  }
  if (step !== null) return [{ label: labels.job, jobId: step }];
  if (root !== null) return [{ label: labels.root, jobId: root }];
  return [];
}

export type TransitionView = {
  readonly key: number;
  readonly fromLabel: string | null;
  readonly toLabel: string;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly jobs: JobLinkView[];
};

export function describeTransition(
  transition: WorkItemTransition,
): TransitionView {
  return {
    key: transition.event_id,
    fromLabel:
      transition.from_status === null
        ? null
        : pipelineStatusLabel(transition.from_status),
    toLabel: pipelineStatusLabel(transition.to_status),
    note: plainOrNull(transition.note),
    occurredAt: transition.occurred_at,
    jobs: jobLinks(
      transition.job_id,
      transition.root_job_id,
      TRANSITION_JOB_LABELS,
    ),
  };
}

/**
 * backendが失敗の文を切る長さ(文字数)。`console_query`の`DETAIL_ERROR_LIMIT`に合わせる。
 * この長さに達した文は切られている可能性があるので、画面で全文ではないと知らせる。
 */
export const FAILURE_ERROR_LIMIT = 4000;

export type FailureRecordView = {
  readonly key: number;
  readonly flowLabel: string;
  readonly error: { readonly text: string; readonly truncated: boolean };
  readonly occurredAt: string;
  readonly jobs: JobLinkView[];
};

export function describeFailureRecord(
  failure: WorkItemFailure,
): FailureRecordView {
  return {
    key: failure.job_failure_id,
    flowLabel:
      failure.step === null
        ? plain(failure.flow_path)
        : `${plain(failure.flow_path)} / ${plain(failure.step)}`,
    error: {
      text: plain(failure.error),
      // 切られたかは、文字の置き換えの前の長さで決める。
      truncated: [...failure.error].length >= FAILURE_ERROR_LIMIT,
    },
    occurredAt: failure.occurred_at,
    jobs: jobLinks(failure.job_id, failure.root_job_id, FAILURE_JOB_LABELS),
  };
}
