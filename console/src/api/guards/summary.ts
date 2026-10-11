// console_queryの"summary"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`ConsoleSummary`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_summary_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullableInteger,
  isNullableIsoTimestamp,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

// 表示にしか使わない種類や状態は文字列で受け、日本語への変換(`labels.ts`)で知らない値を受け止める。
// backendが先に新しい値を反映したときや、配信を前の版に固定している間に、要対応の一覧が丸ごと消えないためである。
// 形の崩れ(項目の欠落、型の違い、idの不正)は、これまでどおり`invalid_response`にする。

/** 承認待ちの1行。要件定義の本文やIssue提案の本文は持たない。 */
export type SummaryApproval = {
  readonly approval_request_id: number;
  readonly kind: string;
  readonly status: string;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly title: string | null;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly requested_at: string;
  readonly expires_at: string | null;
  readonly draft_attempt: number | null;
  readonly summary: string | null;
  readonly proposal_title: string | null;
  readonly created_issue_number: number | null;
  readonly origin: string | null;
};

/** 失敗の1行。作業項目ごとに1行で、失敗の記録が無い作業項目では記録の項目が`null`になる。 */
export type SummaryFailure = {
  readonly work_item_id: number;
  readonly kind: string;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly title: string | null;
  readonly status: string;
  readonly updated_at: string;
  readonly status_note: string | null;
  readonly status_changed_at: string | null;
  readonly job_failure_id: number | null;
  readonly flow_path: string | null;
  readonly job_id: string | null;
  readonly step: string | null;
  readonly error: string | null;
  readonly occurred_at: string | null;
};

/** 要対応の通知の1行。 */
export type SummaryNotice = {
  readonly notice_id: number;
  readonly kind: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly created_at: string;
  readonly severity: string;
  readonly resolvable: boolean;
};

export type SummaryCounts = {
  readonly approvals: number;
  readonly failures: number;
  readonly notices: number;
};

/** "summary"ビューの結果。件数は、一覧の上限を超えた分も数えている。 */
export type ConsoleSummary = {
  readonly counts: SummaryCounts;
  readonly approvals: SummaryApproval[];
  readonly failures: SummaryFailure[];
  readonly notices: SummaryNotice[];
};

function isSummaryApproval(value: unknown): value is SummaryApproval {
  return (
    isRecord(value) &&
    isPositiveInteger(value.approval_request_id) &&
    isString(value.kind) &&
    isString(value.status) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableString(value.title) &&
    isNullableInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableInteger(value.pr_number) &&
    isIsoTimestamp(value.requested_at) &&
    isNullableIsoTimestamp(value.expires_at) &&
    isNullableInteger(value.draft_attempt) &&
    isNullableString(value.summary) &&
    isNullableString(value.proposal_title) &&
    isNullableInteger(value.created_issue_number) &&
    isNullableString(value.origin)
  );
}

function isSummaryFailure(value: unknown): value is SummaryFailure {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.kind) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableInteger(value.pr_number) &&
    isNullableString(value.title) &&
    isString(value.status) &&
    isIsoTimestamp(value.updated_at) &&
    isNullableString(value.status_note) &&
    isNullableIsoTimestamp(value.status_changed_at) &&
    isNullableInteger(value.job_failure_id) &&
    isNullableString(value.flow_path) &&
    isNullableString(value.job_id) &&
    isNullableString(value.step) &&
    isNullableString(value.error) &&
    isNullableIsoTimestamp(value.occurred_at)
  );
}

export function isSummaryNotice(value: unknown): value is SummaryNotice {
  return (
    isRecord(value) &&
    isPositiveInteger(value.notice_id) &&
    isString(value.kind) &&
    isString(value.message) &&
    isBoolean(value.resolved) &&
    isIsoTimestamp(value.created_at) &&
    isString(value.severity) &&
    isBoolean(value.resolvable)
  );
}

function isSummaryCounts(value: unknown): value is SummaryCounts {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.approvals) &&
    isNonNegativeInteger(value.failures) &&
    isNonNegativeInteger(value.notices)
  );
}

const isApprovalList: Guard<SummaryApproval[]> = isArrayOf(isSummaryApproval);
const isFailureList: Guard<SummaryFailure[]> = isArrayOf(isSummaryFailure);
const isNoticeList: Guard<SummaryNotice[]> = isArrayOf(isSummaryNotice);

/** `value`が"summary"ビューの結果の形か。項目が足りない、型が違う、知らない値が入っていれば`false`。 */
export function isConsoleSummary(value: unknown): value is ConsoleSummary {
  return (
    isRecord(value) &&
    isSummaryCounts(value.counts) &&
    isApprovalList(value.approvals) &&
    isFailureList(value.failures) &&
    isNoticeList(value.notices)
  );
}
