// 書き込みのscriptの戻りの型と型ガード。
// 型は`f/factory/approval_decide.ts`、`retry_work_item.ts`、`audit_kickoff.ts`、
// `manual_intake_submit.ts`、`pr_review_submit.ts`、`notice_resolve.ts`と、保留と凍結を解除する2つのscript、ジョブを中止するscript、定期ジョブを再実行するscript、設定を変更するscript、保留と凍結を置くscript、scheduleを止めるscript、反映を承認・却下するscript、全停止を置くscriptと解除するscriptの戻りに合わせる。
// 操作の記録を書けたかを示す`action_audit`は、記録を足した書き込みの戻りが持つ。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_write_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullableIsoTimestamp,
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
  "profile_not_allowed",
  "empty_title",
  "title_too_long",
  "invalid_title_chars",
  "empty_body",
  "invalid_body_chars",
  "body_too_long",
  "invalid_intake_key",
  "intake_key_required",
  "implement_disabled",
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
 * ジョブを中止できなかった理由。`f/factory/console_job_cancel.ts`の`CANCEL_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。画面は日本語の固定文に直す(`lib/writeNotices.ts`)。
 */
export const JOB_CANCEL_REFUSAL_REASONS = [
  "flow_not_allowed",
  "not_a_root_flow",
  "already_finished",
  "already_canceling",
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

/**
 * 定期ジョブを再実行できなかった理由。`f/factory/console_job_rerun.ts`の`RERUN_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。画面は日本語の固定文に直す(`lib/writeNotices.ts`)。
 */
export const JOB_RERUN_REFUSAL_REASONS = [
  "not_scheduled",
  "not_allowed",
  "not_failed",
  "not_finished",
  "already_running",
  "next_run_soon",
  "schedule_disabled",
  "schedule_changed",
  "args_have_reference",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type JobRerunRefusalReason = (typeof JOB_RERUN_REFUSAL_REASONS)[number];

const isJobRerunRefusalReason: Guard<JobRerunRefusalReason> = isOneOf(
  JOB_RERUN_REFUSAL_REASONS,
);

/**
 * 定期ジョブを再実行した結果。`found: false`は、対象外のジョブも含めて、存在しないジョブと同じ応答である。
 * 起動したジョブの`job_id`は、再実行の新しいジョブのidで、結果はその詳細で読む。
 */
export type JobRerunResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: JobRerunRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      readonly job_id: string;
      readonly script_path: string;
      readonly action_audit: ActionAudit;
    };

export function isJobRerunResult(value: unknown): value is JobRerunResult {
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
    return isJobRerunRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isString(value.job_id) &&
    isString(value.script_path) &&
    isActionAudit(value.action_audit)
  );
}

/**
 * 設定を変更できなかった理由。`f/factory/console_config_update.ts`の`CONFIG_UPDATE_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。画面は日本語の固定文に直す(`lib/writeNotices.ts`)。
 */
export const CONFIG_UPDATE_REFUSAL_REASONS = [
  "item_not_allowed",
  "invalid_value",
  "not_lowering",
  "has_reference",
  "conflict",
  "actor_unknown",
  "audit_unavailable",
  // 一覧の追加と削除だけが返す理由。
  "already_present",
  "invalid_element",
  "would_empty",
  "owner_not_listed",
] as const;

export type ConfigUpdateRefusalReason =
  (typeof CONFIG_UPDATE_REFUSAL_REASONS)[number];

const isConfigUpdateRefusalReason: Guard<ConfigUpdateRefusalReason> = isOneOf(
  CONFIG_UPDATE_REFUSAL_REASONS,
);

/** 一覧の項目で行える操作。 */
export type ConfigListOperation = "add" | "remove";

const isConfigListOperation: Guard<ConfigListOperation> = isOneOf([
  "add",
  "remove",
]);

/**
 * 設定を変更した結果。`verified`は、書いた後に読み直した値が期待と同じだったか。
 * 真偽か数値の項目は`before`と`after`を持ち、一覧の項目は`op`、動いた要素、前後の件数を持つ。
 * 両者は`op`の有無で見分ける。
 */
export type ConfigUpdateResult =
  | { readonly refused: true; readonly reason: ConfigUpdateRefusalReason }
  | {
      readonly refused: false;
      readonly item: string;
      readonly before: number | boolean;
      readonly after: number | boolean;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    }
  | {
      readonly refused: false;
      readonly item: string;
      readonly op: ConfigListOperation;
      readonly element: string;
      readonly before_count: number;
      readonly after_count: number;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

function isConfigValue(value: unknown): value is number | boolean {
  return (
    isBoolean(value) || (typeof value === "number" && Number.isFinite(value))
  );
}

export function isConfigUpdateResult(
  value: unknown,
): value is ConfigUpdateResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isConfigUpdateRefusalReason(value.reason);
  }
  if (
    value.refused !== false ||
    !isString(value.item) ||
    !isBoolean(value.verified) ||
    !isActionAudit(value.action_audit)
  ) {
    return false;
  }
  if (value.op !== undefined) {
    return (
      isConfigListOperation(value.op) &&
      isString(value.element) &&
      isNonNegativeInteger(value.before_count) &&
      isNonNegativeInteger(value.after_count)
    );
  }
  return isConfigValue(value.before) && isConfigValue(value.after);
}

/**
 * 保留と凍結を置けなかった理由。`f/factory/console_hold_place.ts`の`PLACE_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。画面は日本語の固定文に直す(`lib/writeNotices.ts`)。
 */
export const HOLD_PLACE_REFUSAL_REASONS = [
  "invalid_kind",
  "invalid_target",
  "invalid_minutes",
  "invalid_reason",
  "target_not_allowed",
  "already_active",
  "other_holder_active",
  "limit_reached",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type HoldPlaceRefusalReason =
  (typeof HOLD_PLACE_REFUSAL_REASONS)[number];

export type HoldPlaceResult =
  | { readonly refused: true; readonly reason: HoldPlaceRefusalReason }
  | {
      readonly refused: false;
      readonly kind: "merge" | "deploy" | "freeze";
      readonly id: string;
      readonly target: string;
      readonly created_at: string;
      readonly expires_at: string;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

const isHoldPlaceRefusalReason: Guard<HoldPlaceRefusalReason> = isOneOf(
  HOLD_PLACE_REFUSAL_REASONS,
);

const isPlaceKind: Guard<"merge" | "deploy" | "freeze"> = isOneOf([
  "merge",
  "deploy",
  "freeze",
]);

export function isHoldPlaceResult(value: unknown): value is HoldPlaceResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isHoldPlaceRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isPlaceKind(value.kind) &&
    isString(value.id) &&
    isString(value.target) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.expires_at) &&
    isBoolean(value.verified) &&
    isActionAudit(value.action_audit)
  );
}

/**
 * スケジュールを止められなかった理由。`f/factory/console_schedule_stop.ts`の`STOP_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。
 */
export const SCHEDULE_STOP_REFUSAL_REASONS = [
  "not_allowed",
  "no_freeze",
  "other_holder_freeze",
  "too_early",
  "freeze_ending",
  "self_update_running",
  "schedule_changed",
  "already_stopped",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type ScheduleStopRefusalReason =
  (typeof SCHEDULE_STOP_REFUSAL_REASONS)[number];

export type ScheduleStopResult =
  | {
      readonly refused: true;
      readonly reason: ScheduleStopRefusalReason;
      readonly ready_at: string | null;
    }
  | {
      readonly refused: false;
      readonly schedule_path: string;
      readonly freeze_id: string;
      readonly enabled: boolean;
      readonly freeze_expires_at: string;
      readonly verified: boolean;
      /** 無効にした後の読み直しで、止めたときの凍結がまだ有効だったか。 */
      readonly freeze_held: boolean;
      readonly action_audit: ActionAudit;
    };

const isScheduleStopRefusalReason: Guard<ScheduleStopRefusalReason> = isOneOf(
  SCHEDULE_STOP_REFUSAL_REASONS,
);

export function isScheduleStopResult(
  value: unknown,
): value is ScheduleStopResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return (
      isScheduleStopRefusalReason(value.reason) &&
      isNullableIsoTimestamp(value.ready_at)
    );
  }
  return (
    value.refused === false &&
    isString(value.schedule_path) &&
    isString(value.freeze_id) &&
    isBoolean(value.enabled) &&
    isIsoTimestamp(value.freeze_expires_at) &&
    isBoolean(value.verified) &&
    isBoolean(value.freeze_held) &&
    isActionAudit(value.action_audit)
  );
}

/**
 * PRのレビューの投入を断った理由。`f/factory/pr_review_submit.ts`の
 * `PR_REVIEW_SUBMIT_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。
 * 理由に入力の文字列は含まれない。`already_reviewing`は、同じPRの稼働中のレビューがあることを、同期に操作者へ届ける。
 */
export const PR_REVIEW_SUBMIT_REFUSAL_REASONS = [
  "invalid_owner",
  "invalid_repo",
  "invalid_pr_number",
  "repo_not_allowed",
  "actor_unknown",
  "already_reviewing",
] as const;

export type PrReviewSubmitRefusalReason =
  (typeof PR_REVIEW_SUBMIT_REFUSAL_REASONS)[number];

export type PrReviewSubmitResult =
  | {
      readonly refused: true;
      readonly reason: PrReviewSubmitRefusalReason;
    }
  | {
      readonly refused: false;
      readonly flow_job_id: string;
      readonly action_audit?: ActionAudit;
    };

const isPrReviewSubmitRefusalReason: Guard<PrReviewSubmitRefusalReason> =
  isOneOf(PR_REVIEW_SUBMIT_REFUSAL_REASONS);

export function isPrReviewSubmitResult(
  value: unknown,
): value is PrReviewSubmitResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isPrReviewSubmitRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isString(value.flow_job_id) &&
    isOptionalActionAudit(value.action_audit)
  );
}

/**
 * PRのレビューの登録のステップが断った理由。`f/factory/steps/pr_review_intake_register.ts`の
 * `PR_REVIEW_REGISTER_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。
 * 投入の入口は起動だけを返すので、この理由は、投入したフローのジョブの結果に現れる。
 */
export const PR_REVIEW_REGISTER_REFUSAL_REASONS = [
  "invalid_pr_number",
  "repo_not_allowed",
  "pr_not_found",
  "pr_closed",
  "fork_head",
  "owner_mismatch",
  "repo_mismatch",
  "already_reviewing",
] as const;

export type PrReviewRegisterRefusalReason =
  (typeof PR_REVIEW_REGISTER_REFUSAL_REASONS)[number];

export type PrReviewRegisterResult =
  | {
      readonly status: "started";
      readonly work_item_id: number;
      readonly flow_job_id: string;
    }
  | {
      readonly status: "refused";
      readonly reason: PrReviewRegisterRefusalReason;
    };

const isPrReviewRegisterRefusalReason: Guard<PrReviewRegisterRefusalReason> =
  isOneOf(PR_REVIEW_REGISTER_REFUSAL_REASONS);

/**
 * 登録のステップのジョブの結果。4bの画面が、投入したフローのジョブの結果を読むときに使う。
 */
export function isPrReviewRegisterResult(
  value: unknown,
): value is PrReviewRegisterResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === "refused") {
    return isPrReviewRegisterRefusalReason(value.reason);
  }
  return (
    value.status === "started" &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.flow_job_id)
  );
}

/** 反映の判断を断った理由。`f/factory/console_deploy_decide.ts`の同じ名前の定数と同じ並びで、契約テストが突き合わせる。 */
export const DEPLOY_DECIDE_REFUSAL_REASONS = [
  "invalid_sha",
  "invalid_decision",
  "not_pending",
  "actor_unknown",
  "audit_unavailable",
] as const;
export type DeployDecideRefusalReason =
  (typeof DEPLOY_DECIDE_REFUSAL_REASONS)[number];

/** 反映の判断の結果。`notice`は判断の情報の通知を残せたか。 */
export type DeployDecideResult =
  | { readonly refused: true; readonly reason: DeployDecideRefusalReason }
  | {
      readonly refused: false;
      readonly sha: string;
      readonly decision: "approved" | "rejected";
      readonly notice: "recorded" | "failed";
      readonly action_audit: ActionAudit;
    };

const isDeployDecideRefusalReason: Guard<DeployDecideRefusalReason> = isOneOf(
  DEPLOY_DECIDE_REFUSAL_REASONS,
);
const isDeployDecision: Guard<"approved" | "rejected"> = isOneOf([
  "approved",
  "rejected",
]);
const isNoticeAudit: Guard<"recorded" | "failed"> = isOneOf([
  "recorded",
  "failed",
]);

export function isDeployDecideResult(
  value: unknown,
): value is DeployDecideResult {
  if (!isRecord(value)) return false;
  if (value.refused === true) {
    return isDeployDecideRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isString(value.sha) &&
    isDeployDecision(value.decision) &&
    isNoticeAudit(value.notice) &&
    isActionAudit(value.action_audit)
  );
}

/**
 * 全停止を置けなかった理由。`f/factory/console_stop_all.ts`の`STOP_ALL_REFUSAL_REASONS`と
 * 同じ並びで、契約テストが突き合わせる。
 */
export const STOP_ALL_REFUSAL_REASONS = [
  "invalid_reason",
  "state_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllRefusalReason = (typeof STOP_ALL_REFUSAL_REASONS)[number];

export type StopAllConfigOutcome =
  | "written"
  | "unchanged"
  | "has_reference"
  | "failed";

export type StopAllResult =
  | { readonly refused: true; readonly reason: StopAllRefusalReason }
  | {
      readonly refused: false;
      readonly placed: boolean;
      readonly placed_at: string;
      readonly config: StopAllConfigOutcome;
      readonly disabled_flags: readonly string[];
      readonly schedules_disabled: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

const isStopAllRefusalReason: Guard<StopAllRefusalReason> = isOneOf(
  STOP_ALL_REFUSAL_REASONS,
);

const isStopAllConfigOutcome: Guard<StopAllConfigOutcome> = isOneOf([
  "written",
  "unchanged",
  "has_reference",
  "failed",
]);

const isStrings: Guard<string[]> = isArrayOf(isString);

export function isStopAllResult(value: unknown): value is StopAllResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isStopAllRefusalReason(value.reason);
  }
  return (
    value.refused === false &&
    isBoolean(value.placed) &&
    isIsoTimestamp(value.placed_at) &&
    isStopAllConfigOutcome(value.config) &&
    isStrings(value.disabled_flags) &&
    isStrings(value.schedules_disabled) &&
    isStrings(value.schedules_failed) &&
    isActionAudit(value.action_audit)
  );
}

/**
 * 全停止を解除できなかった理由。`f/factory/console_stop_all_release.ts`の
 * `STOP_ALL_RELEASE_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。
 */
export const STOP_ALL_RELEASE_REFUSAL_REASONS = [
  "state_unreadable",
  "freezes_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllReleaseRefusalReason =
  (typeof STOP_ALL_RELEASE_REFUSAL_REASONS)[number];

export type StopAllReleaseResult =
  | { readonly refused: true; readonly reason: StopAllReleaseRefusalReason }
  | { readonly refused: false; readonly released: false }
  | {
      readonly refused: false;
      readonly released: true;
      readonly schedules_enabled: readonly string[];
      readonly schedules_skipped: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

const isStopAllReleaseRefusalReason: Guard<StopAllReleaseRefusalReason> =
  isOneOf(STOP_ALL_RELEASE_REFUSAL_REASONS);

export function isStopAllReleaseResult(
  value: unknown,
): value is StopAllReleaseResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.refused === true) {
    return isStopAllReleaseRefusalReason(value.reason);
  }
  if (value.refused !== false) {
    return false;
  }
  if (value.released === false) {
    return true;
  }
  return (
    value.released === true &&
    isStrings(value.schedules_enabled) &&
    isStrings(value.schedules_skipped) &&
    isStrings(value.schedules_failed) &&
    isActionAudit(value.action_audit)
  );
}
