// console_holdsの応答の型と型ガード。反映の承認待ちも含む。
// 型は`f/factory/lib/console_holds_support.ts`の`HoldsSnapshot`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_holds_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

export type HoldRowView = {
  readonly id: number;
  readonly scope: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: string;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

export type FreezeRowView = {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: string;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

export type DeployFreezeRowView = Omit<FreezeRowView, "target">;

export type HoldsRead =
  | { readonly ok: true; readonly rows: readonly HoldRowView[] }
  | { readonly ok: false; readonly kind: string; readonly reason: string };

export type FreezesRead =
  | {
      readonly ok: true;
      readonly schedule: readonly FreezeRowView[];
      readonly deploy: readonly DeployFreezeRowView[];
    }
  | { readonly ok: false; readonly reason: string };

export type DeployApprovalRowView = {
  readonly sha: string;
  readonly protected_paths: readonly string[];
  readonly protected_path_count: number;
  readonly requested_at: string;
};

export type DeployApprovalsRead =
  | { readonly ok: true; readonly pending: readonly DeployApprovalRowView[] }
  | { readonly ok: false; readonly reason: string };

export type HoldsSnapshot = {
  readonly holds: HoldsRead;
  readonly freezes: FreezesRead;
  /** 反映の承認待ち。承認待ちを返さない旧版のbackendの間は欠ける。 */
  readonly deploy_approvals?: DeployApprovalsRead;
};

// scopeとholder_kindと失敗のkindは表示にしか使わないので文字列で受け、日本語への変換(`labels.ts`)で
// 知らない値を受け止める。backendが先に新しい値を反映した間も、一覧の全体が消えないためである。

function hasCommonFields(value: Record<string, unknown>): boolean {
  return (
    isString(value.reason) &&
    isString(value.holder_kind) &&
    isString(value.holder) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.expires_at)
  );
}

function isHoldRowView(value: unknown): value is HoldRowView {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    isString(value.scope) &&
    isString(value.target) &&
    hasCommonFields(value)
  );
}

function isFreezeRowView(value: unknown): value is FreezeRowView {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.target) &&
    hasCommonFields(value)
  );
}

function isDeployFreezeRowView(value: unknown): value is DeployFreezeRowView {
  return isRecord(value) && isString(value.id) && hasCommonFields(value);
}

const isHoldRows: Guard<HoldRowView[]> = isArrayOf(isHoldRowView);
const isFreezeRows: Guard<FreezeRowView[]> = isArrayOf(isFreezeRowView);
const isDeployRows: Guard<DeployFreezeRowView[]> = isArrayOf(
  isDeployFreezeRowView,
);

function isHoldsRead(value: unknown): value is HoldsRead {
  if (!isRecord(value) || !isBoolean(value.ok)) {
    return false;
  }
  return value.ok
    ? isHoldRows(value.rows)
    : isString(value.kind) && isString(value.reason);
}

function isFreezesRead(value: unknown): value is FreezesRead {
  if (!isRecord(value) || !isBoolean(value.ok)) {
    return false;
  }
  return value.ok
    ? isFreezeRows(value.schedule) && isDeployRows(value.deploy)
    : isString(value.reason);
}

function isDeployApprovalRowView(
  value: unknown,
): value is DeployApprovalRowView {
  return (
    isRecord(value) &&
    isString(value.sha) &&
    isArrayOf(isString)(value.protected_paths) &&
    isPositiveInteger(value.protected_path_count) &&
    isIsoTimestamp(value.requested_at)
  );
}

const isDeployApprovalRows: Guard<DeployApprovalRowView[]> = isArrayOf(
  isDeployApprovalRowView,
);

function isDeployApprovalsRead(value: unknown): value is DeployApprovalsRead {
  if (!isRecord(value) || !isBoolean(value.ok)) {
    return false;
  }
  return value.ok
    ? isDeployApprovalRows(value.pending)
    : isString(value.reason);
}

/**
 * `value`がconsole_holdsの結果の形か。保留、凍結、承認待ちは別々の源なので、どの失敗も正しい形として受ける。
 * 承認待ちは、旧版のbackendが返さない間も一覧の全体が消えないよう、欠けていてもよい。
 */
export function isHoldsSnapshot(value: unknown): value is HoldsSnapshot {
  return (
    isRecord(value) &&
    isHoldsRead(value.holds) &&
    isFreezesRead(value.freezes) &&
    (value.deploy_approvals === undefined ||
      isDeployApprovalsRead(value.deploy_approvals))
  );
}
