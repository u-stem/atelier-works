// console_queryの"work_item_detail"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`WorkItemDetail`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_item_detail_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullable,
  isNullableInteger,
  isNullableIsoTimestamp,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";
import {
  isWorkItemFailureList,
  type WorkItemFailure,
} from "./workItemFailures.ts";
import {
  isWorkItemTransitionList,
  type WorkItemTransition,
} from "./workItemTransitions.ts";

// 状態、種別、結果の種類は表示にしか使わないので文字列で受け、
// 日本語への変換(`lib/itemDetailView.ts`)で知らない値を受け止める。
// backendが先に新しい値を反映した間も、詳細の全体が消えないためである。

const isFiniteNumber: Guard<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNullableFiniteNumber = isNullable(isFiniteNumber);

/** 作業項目の概要。題名、ブランチ、URL、状態の注記は信頼できない文字列で、画面には検査してから出す。 */
export type WorkItemOverview = {
  readonly work_item_id: number;
  readonly kind: string;
  readonly source: string;
  readonly cycle: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly branch: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly fix_round: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status_note: string | null;
  /** 実行の記録が無ければ`null`。 */
  readonly total_cost_usd: number | null;
  readonly run_count: number;
};

function isWorkItemOverview(value: unknown): value is WorkItemOverview {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.kind) &&
    isString(value.source) &&
    isNonNegativeInteger(value.cycle) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableInteger(value.pr_number) &&
    isNullableString(value.pr_url) &&
    isNullableString(value.branch) &&
    isNullableString(value.title) &&
    isString(value.status) &&
    isNonNegativeInteger(value.attempt) &&
    isNonNegativeInteger(value.fix_round) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.updated_at) &&
    isNullableString(value.status_note) &&
    isNullableFiniteNumber(value.total_cost_usd) &&
    isNonNegativeInteger(value.run_count)
  );
}

/** 要件定義の試行1回分。承認依頼があれば、その状態を添える。 */
export type WorkItemAttempt = {
  readonly attempt: number;
  readonly summary: string;
  readonly created_at: string;
  readonly approval_request_id: number | null;
  readonly approval_status: string | null;
};

function isWorkItemAttempt(value: unknown): value is WorkItemAttempt {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.attempt) &&
    isString(value.summary) &&
    isIsoTimestamp(value.created_at) &&
    isNullableInteger(value.approval_request_id) &&
    isNullableString(value.approval_status)
  );
}

/**
 * 承認依頼1件の履歴。`reason`は却下の理由、`decided_by`は決めた人、
 * `draft_attempt`は要件定義の承認依頼が指す試行である。
 */
export type WorkItemApproval = {
  readonly approval_request_id: number;
  readonly kind: string;
  readonly status: string;
  readonly requested_at: string;
  readonly expires_at: string | null;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly reason: string | null;
  readonly draft_attempt: number | null;
  readonly proposal_title: string | null;
};

function isWorkItemApproval(value: unknown): value is WorkItemApproval {
  return (
    isRecord(value) &&
    isPositiveInteger(value.approval_request_id) &&
    isString(value.kind) &&
    isString(value.status) &&
    isIsoTimestamp(value.requested_at) &&
    isNullableIsoTimestamp(value.expires_at) &&
    isNullableIsoTimestamp(value.decided_at) &&
    isNullableString(value.decided_by) &&
    isNullableString(value.reason) &&
    isNullableInteger(value.draft_attempt) &&
    isNullableString(value.proposal_title)
  );
}

export type WorkItemDiffStat = {
  readonly files: number;
  readonly added: number;
  readonly deleted: number;
};

function isWorkItemDiffStat(value: unknown): value is WorkItemDiffStat {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.files) &&
    isNonNegativeInteger(value.added) &&
    isNonNegativeInteger(value.deleted)
  );
}

/** 実装の1ラウンド。検査コマンドの出力は持たない。 */
export type WorkItemRound = {
  readonly round_id: number;
  readonly attempt: number;
  readonly round: number;
  readonly mode: string;
  readonly outcome: string;
  readonly summary: string;
  readonly gap_report: string | null;
  readonly checks_skipped_reason: string | null;
  readonly protected_changes: string[];
  readonly diff_stat: WorkItemDiffStat | null;
  readonly created_at: string;
};

const isStringList = isArrayOf(isString);

function isWorkItemRound(value: unknown): value is WorkItemRound {
  return (
    isRecord(value) &&
    isPositiveInteger(value.round_id) &&
    isNonNegativeInteger(value.attempt) &&
    isNonNegativeInteger(value.round) &&
    isString(value.mode) &&
    isString(value.outcome) &&
    isString(value.summary) &&
    isNullableString(value.gap_report) &&
    isNullableString(value.checks_skipped_reason) &&
    isStringList(value.protected_changes) &&
    isNullable(isWorkItemDiffStat)(value.diff_stat) &&
    isIsoTimestamp(value.created_at)
  );
}

/** PRレビュー1回分の一覧用の行。本文や指摘の文は持たず、件数だけを持つ。 */
export type WorkItemReview = {
  readonly review_id: number;
  readonly head_sha: string;
  readonly verdict: string;
  readonly result: string | null;
  readonly finding_count: number;
  readonly posted_review_id: string | null;
  readonly created_at: string;
};

function isWorkItemReview(value: unknown): value is WorkItemReview {
  return (
    isRecord(value) &&
    isPositiveInteger(value.review_id) &&
    isString(value.head_sha) &&
    isString(value.verdict) &&
    isNullableString(value.result) &&
    isNonNegativeInteger(value.finding_count) &&
    isNullableString(value.posted_review_id) &&
    isIsoTimestamp(value.created_at)
  );
}

/** PR修正1回分の一覧用の行。返信の本文は持たず、件数だけを持つ。 */
export type WorkItemFixRound = {
  readonly fix_round_id: number;
  readonly round: number;
  readonly outcome: string;
  readonly trigger_review_count: number;
  readonly reply_count: number;
  readonly commit_count: number;
  readonly created_at: string;
};

function isWorkItemFixRound(value: unknown): value is WorkItemFixRound {
  return (
    isRecord(value) &&
    isPositiveInteger(value.fix_round_id) &&
    isNonNegativeInteger(value.round) &&
    isString(value.outcome) &&
    isNonNegativeInteger(value.trigger_review_count) &&
    isNonNegativeInteger(value.reply_count) &&
    isNonNegativeInteger(value.commit_count) &&
    isIsoTimestamp(value.created_at)
  );
}

/** 作業項目1件の概要と、その履歴。履歴の並びはbackendが決め、新しい順のものと古い順のものがある。 */
export type WorkItemDetail = {
  readonly work_item: WorkItemOverview;
  readonly attempts: WorkItemAttempt[];
  readonly approvals: WorkItemApproval[];
  readonly implement_rounds: WorkItemRound[];
  readonly failures: WorkItemFailure[];
  readonly transitions: WorkItemTransition[];
  readonly reviews: WorkItemReview[];
  readonly fix_rounds: WorkItemFixRound[];
};

const isAttemptList = isArrayOf(isWorkItemAttempt);
const isApprovalList = isArrayOf(isWorkItemApproval);
const isRoundList = isArrayOf(isWorkItemRound);
const isReviewList = isArrayOf(isWorkItemReview);
const isFixRoundList = isArrayOf(isWorkItemFixRound);

export function isWorkItemDetail(value: unknown): value is WorkItemDetail {
  return (
    isRecord(value) &&
    isWorkItemOverview(value.work_item) &&
    isAttemptList(value.attempts) &&
    isApprovalList(value.approvals) &&
    isRoundList(value.implement_rounds) &&
    isWorkItemFailureList(value.failures) &&
    isWorkItemTransitionList(value.transitions) &&
    isReviewList(value.reviews) &&
    isFixRoundList(value.fix_rounds)
  );
}
