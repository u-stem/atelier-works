// 書き込みのscriptの戻りの型と型ガード。
// 型は`f/factory/approval_decide.ts`、`retry_work_item.ts`、`audit_kickoff.ts`、
// `manual_intake_submit.ts`、`notice_resolve.ts`と、保留と凍結を解除する2つのscript、ジョブを取り消すscriptの戻りに合わせる。
// 操作の記録を書けたかを示す`action_audit`は、記録を足した書き込みの戻りが持つ。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_write_contract.test.ts`が落ちる。

import {
  type Guard,
  isBoolean,
  isNullableString,
  isOneOf,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

export type ApprovalDecideResult = {
  readonly ok: true;
  readonly status: "approved" | "rejected";
  readonly job_id: string;
};

const isDecisionStatus: Guard<"approved" | "rejected"> = isOneOf([
  "approved",
  "rejected",
]);

export function isApprovalDecideResult(
  value: unknown,
): value is ApprovalDecideResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isDecisionStatus(value.status) &&
    isString(value.job_id)
  );
}

/**
 * 再開の結果。`ok: false`は、別の実行が先にリースを取っていて、
 * 起動したジョブを作業項目に記録できなかったことを表す。
 * 状態は表示にしか使わないので文字列で受け、日本語への変換(`labels.ts`)で知らない値を受け止める。
 */
export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly started_job_id: string;
  readonly flow_job_id: string | null;
  readonly action_audit?: ActionAudit;
};

export function isRetryWorkItemResult(
  value: unknown,
): value is RetryWorkItemResult {
  return (
    isRecord(value) &&
    isBoolean(value.ok) &&
    isString(value.status) &&
    isString(value.started_job_id) &&
    isNullableString(value.flow_job_id) &&
    isOptionalActionAudit(value.action_audit)
  );
}

/** 監査を起動しなかった理由。`concurrent_kickoff`は、同時の起動に先を越されたときである。 */
export const AUDIT_SKIP_REASONS = [
  "audit_in_progress",
  "empty_period",
  "no_new_records",
  "daily_budget_exceeded",
  "concurrent_kickoff",
] as const;

export type AuditSkipReason = (typeof AUDIT_SKIP_REASONS)[number];

export type AuditKickoffResult =
  | { readonly skipped: true; readonly reason: AuditSkipReason }
  | {
      readonly skipped: false;
      readonly work_item_id: number;
      readonly flow_job_id: string;
      readonly period_label: string;
    };

const isAuditSkipReason: Guard<AuditSkipReason> = isOneOf(AUDIT_SKIP_REASONS);

export function isAuditKickoffResult(
  value: unknown,
): value is AuditKickoffResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.skipped === true) {
    return isAuditSkipReason(value.reason);
  }
  return (
    value.skipped === false &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.flow_job_id) &&
    isString(value.period_label)
  );
}

export type NoticeResolveResult = {
  readonly ok: true;
  readonly status: "resolved" | "already_resolved";
  readonly notice_id: number;
};

const isNoticeResolveStatus: Guard<"resolved" | "already_resolved"> = isOneOf([
  "resolved",
  "already_resolved",
]);

export function isNoticeResolveResult(
  value: unknown,
): value is NoticeResolveResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isNoticeResolveStatus(value.status) &&
    isPositiveInteger(value.notice_id)
  );
}

/**
 * 手動投入を断った理由。`f/factory/lib/manual_intake_support.ts`の
 * `MANUAL_INTAKE_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。
 * 理由に入力の文字列は含まれない。画面は日本語の固定文に直す(`lib/intakeRefusal.ts`)。
 */
export const MANUAL_INTAKE_REFUSAL_REASONS = [
  "invalid_owner",
  "invalid_repo",
  "repo_not_allowed",
  "empty_title",
  "title_too_long",
  "invalid_title_chars",
  "empty_body",
  "invalid_body_chars",
  "body_too_long",
  "actor_unknown",
] as const;

export type ManualIntakeRefusalReason =
  (typeof MANUAL_INTAKE_REFUSAL_REASONS)[number];

export type ManualIntakeSubmitResult =
  | {
      readonly refused: true;
      readonly reason: ManualIntakeRefusalReason;
    }
  | {
      readonly refused: false;
      readonly flow_job_id: string;
      readonly action_audit?: ActionAudit;
    };

const isManualIntakeRefusalReason: Guard<ManualIntakeRefusalReason> = isOneOf(
  MANUAL_INTAKE_REFUSAL_REASONS,
);

export function isManualIntakeSubmitResult(
  value: unknown,
): value is ManualIntakeSubmitResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isManualIntakeRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isString(value.flow_job_id) &&
    isOptionalActionAudit(value.action_audit)
  );
}

/**
 * 操作の記録(`factory.console_actions`)を書けたか。`failed`でも操作は済んでいる。
 * 保留と凍結の解除の戻りにある`audit`は、解除の通知(`hold_released`)を書けたかで、別の記録である。
 */
export type ActionAudit = "recorded" | "failed";

const isActionAudit: Guard<ActionAudit> = isOneOf(["recorded", "failed"]);

/** 記録を書く前の戻りでは`action_audit`が欠ける。 */
function isOptionalActionAudit(value: unknown): boolean {
  return value === undefined || isActionAudit(value);
}

type ReleaseAudit = "recorded" | "failed";

const isReleaseAudit: Guard<ReleaseAudit> = isOneOf(["recorded", "failed"]);

/** 通知を試みなかった解除では`audit`が欠ける。 */
function isOptionalAudit(value: unknown): boolean {
  return value === undefined || isReleaseAudit(value);
}

/**
 * 保留の解除の結果。`was_active`は解除する前に有効だったか。
 * 期限切れの行を片付けただけのときは偽で、通知を残さないので`audit`が欠ける。
 * `active_unknown`は、有効な保留の一覧を読めず、有効だったかを確かめられなかったときだけ付く。
 */
export type HoldReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_released";
  readonly hold_id: number;
  readonly was_active: boolean;
  readonly active_unknown?: true;
  readonly audit?: ReleaseAudit;
  readonly action_audit?: ActionAudit;
};

const isHoldReleaseStatus: Guard<"released" | "already_released"> = isOneOf([
  "released",
  "already_released",
]);

export function isHoldReleaseResult(
  value: unknown,
): value is HoldReleaseResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isHoldReleaseStatus(value.status) &&
    isPositiveInteger(value.hold_id) &&
    isBoolean(value.was_active) &&
    (value.active_unknown === undefined || value.active_unknown === true) &&
    isOptionalAudit(value.audit) &&
    isOptionalActionAudit(value.action_audit)
  );
}

/**
 * 凍結かdeployの保留の解除の結果。`unconfirmed`は、書いた後に読み直した変数に解除が残っていなかったこと。
 * `scope`と`audit`は`released`のときだけ付く。
 */
export type FreezeReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_ended" | "unconfirmed";
  readonly freeze_id: string;
  readonly scope?: "schedule" | "deploy";
  readonly audit?: ReleaseAudit;
  readonly action_audit?: ActionAudit;
};

const isFreezeReleaseStatus: Guard<
  "released" | "already_ended" | "unconfirmed"
> = isOneOf(["released", "already_ended", "unconfirmed"]);

const isFreezeScope: Guard<"schedule" | "deploy"> = isOneOf([
  "schedule",
  "deploy",
]);

export function isFreezeReleaseResult(
  value: unknown,
): value is FreezeReleaseResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isFreezeReleaseStatus(value.status) &&
    isString(value.freeze_id) &&
    (value.scope === undefined || isFreezeScope(value.scope)) &&
    isOptionalAudit(value.audit) &&
    isOptionalActionAudit(value.action_audit)
  );
}

/**
 * ジョブを中止(取消)できなかった理由。`f/factory/console_job_cancel.ts`の`CANCEL_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。画面は日本語の固定文に直す(`lib/writeNotices.ts`)。
 */
export const JOB_CANCEL_REFUSAL_REASONS = [
  "flow_not_allowed",
  "not_a_root_flow",
  "already_finished",
  "scheduled_for_later",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type JobCancelRefusalReason =
  (typeof JOB_CANCEL_REFUSAL_REASONS)[number];

const isJobCancelRefusalReason: Guard<JobCancelRefusalReason> = isOneOf(
  JOB_CANCEL_REFUSAL_REASONS,
);

/** 中止の後に読み直した作業項目。`lease_held`は、リースがまだそのジョブを指しているか。 */
export type JobCancelWorkItem = {
  readonly id: number;
  readonly status: string;
  readonly lease_held: boolean;
};

/**
 * ジョブを中止した結果。`found: false`は、対象外のジョブも含めて、存在しないジョブと同じ応答である。
 * `job_state`と`work_item`は、中止の後に読み直せなかったときに`null`になる。
 */
export type JobCancelResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: JobCancelRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      readonly job_id: string;
      readonly flow_path: string;
      readonly job_state: string | null;
      readonly work_item: JobCancelWorkItem | null;
      readonly action_audit: ActionAudit;
    };

function isJobCancelWorkItem(value: unknown): value is JobCancelWorkItem {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    isString(value.status) &&
    isBoolean(value.lease_held)
  );
}

export function isJobCancelResult(value: unknown): value is JobCancelResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.found === false) {
    return true;
  }
  if (value.found !== true) {
    return false;
  }
  if (value.refused === true) {
    return isJobCancelRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isString(value.job_id) &&
    isString(value.flow_path) &&
    isNullableString(value.job_state) &&
    (value.work_item === null || isJobCancelWorkItem(value.work_item)) &&
    isActionAudit(value.action_audit)
  );
}
