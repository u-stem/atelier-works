// console_queryの"system_status"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`SystemStatus`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_system_contract.test.ts`が落ちる。

import { isNoticeRows, type NoticeRow } from "./notices.ts";
import {
  type Guard,
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isNullableInteger,
  isNullableIsoTimestamp,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

// 取り込みの状態と判定は表示にしか使わないので文字列で受け、日本語への変換(`systemView.ts`)で知らない値を受け止める。
// backendが先に新しい値を反映した間も、画面の全体が消えないためである。

/** 直近の反映1回。履歴(`deployments`view)と違い、PRは持たない。 */
export type SystemDeployment = {
  readonly sha_from: string | null;
  readonly sha_to: string;
  readonly changed_paths: string[];
  readonly result: string;
  readonly needs_host_action: boolean;
  readonly occurred_at: string;
};

/** Consoleの取り込みの状態。`status.json`を読めなければ`unavailable`。 */
export type SystemFetcher =
  | {
      readonly availability: "unavailable";
      readonly reason: string;
    }
  | {
      readonly availability: "available";
      readonly state: string;
      readonly sha: string | null;
      readonly checked_at: string;
      readonly error: string | null;
      readonly assessment: string;
      readonly minutes_since_check: number | null;
      readonly next_action: string | null;
    };

/** 作業項目の無い失敗(定期ジョブの失敗)。 */
export type SystemOrphanFailure = {
  readonly job_failure_id: number;
  readonly flow_path: string;
  readonly job_id: string;
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
};

/** 解決済みの通知。誰がいつ解決したかの記録が無い行では`null`。 */
export type SystemResolvedNotice = {
  readonly notice_id: number;
  readonly kind: string;
  readonly message: string;
  readonly created_at: string;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
};

/** "system_status"ビューの結果。 */
export type SystemStatus = {
  readonly deployed_sha: string | null;
  readonly deployment: SystemDeployment | null;
  readonly fetcher: SystemFetcher;
  readonly orphan_failures: SystemOrphanFailure[];
  readonly info_notices: NoticeRow[];
  readonly resolved_notices: SystemResolvedNotice[];
};

const isStringList: Guard<string[]> = isArrayOf(isString);

function isSystemDeployment(value: unknown): value is SystemDeployment {
  return (
    isRecord(value) &&
    isNullableString(value.sha_from) &&
    isString(value.sha_to) &&
    isStringList(value.changed_paths) &&
    isString(value.result) &&
    isBoolean(value.needs_host_action) &&
    isIsoTimestamp(value.occurred_at)
  );
}

function isSystemFetcher(value: unknown): value is SystemFetcher {
  if (!isRecord(value)) {
    return false;
  }
  if (value.availability === "unavailable") {
    return isString(value.reason);
  }
  return (
    value.availability === "available" &&
    isString(value.state) &&
    isNullableString(value.sha) &&
    isIsoTimestamp(value.checked_at) &&
    isNullableString(value.error) &&
    isString(value.assessment) &&
    isNullableInteger(value.minutes_since_check) &&
    isNullableString(value.next_action)
  );
}

function isSystemOrphanFailure(value: unknown): value is SystemOrphanFailure {
  return (
    isRecord(value) &&
    isPositiveInteger(value.job_failure_id) &&
    isString(value.flow_path) &&
    isString(value.job_id) &&
    isNullableString(value.step) &&
    isString(value.error) &&
    isIsoTimestamp(value.occurred_at)
  );
}

function isSystemResolvedNotice(value: unknown): value is SystemResolvedNotice {
  return (
    isRecord(value) &&
    isPositiveInteger(value.notice_id) &&
    isString(value.kind) &&
    isString(value.message) &&
    isIsoTimestamp(value.created_at) &&
    isNullableString(value.resolved_by) &&
    isNullableIsoTimestamp(value.resolved_at)
  );
}

const isOrphanFailureList: Guard<SystemOrphanFailure[]> = isArrayOf(
  isSystemOrphanFailure,
);
const isResolvedNoticeList: Guard<SystemResolvedNotice[]> = isArrayOf(
  isSystemResolvedNotice,
);

/** `value`が"system_status"ビューの結果の形か。項目が足りない、型が違う値が入っていれば`false`。 */
export function isSystemStatus(value: unknown): value is SystemStatus {
  return (
    isRecord(value) &&
    isNullableString(value.deployed_sha) &&
    (value.deployment === null || isSystemDeployment(value.deployment)) &&
    isSystemFetcher(value.fetcher) &&
    isOrphanFailureList(value.orphan_failures) &&
    isNoticeRows(value.info_notices) &&
    isResolvedNoticeList(value.resolved_notices)
  );
}
