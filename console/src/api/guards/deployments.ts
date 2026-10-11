// console_queryの"deployments"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`DeploymentHistoryRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_deployments_contract.test.ts`が落ちる。

import {
  type Guard,
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

// 作り手と結果は表示にしか使わないので文字列で受け、日本語への変換(`labels.ts`)で知らない値を受け止める。
// backendが先に新しい値を反映した間も、履歴の全体が消えないためである。

/** 反映に含まれるPR1件。題名は信頼できない文字列で、画面には文字としてだけ出す。 */
export type DeploymentPullRequest = {
  readonly number: number;
  readonly title: string | null;
  readonly origin: string;
  readonly url: string | null;
};

/** 反映1回。 */
export type DeploymentEntry = {
  readonly deployment_id: number;
  readonly sha_from: string | null;
  readonly sha_to: string;
  readonly result: string;
  readonly needs_host_action: boolean;
  readonly occurred_at: string;
  readonly pull_requests: DeploymentPullRequest[];
};

function isDeploymentPullRequest(
  value: unknown,
): value is DeploymentPullRequest {
  return (
    isRecord(value) &&
    isPositiveInteger(value.number) &&
    isNullableString(value.title) &&
    isString(value.origin) &&
    isNullableString(value.url)
  );
}

const isPullRequestList: Guard<DeploymentPullRequest[]> = isArrayOf(
  isDeploymentPullRequest,
);

function isDeploymentEntry(value: unknown): value is DeploymentEntry {
  return (
    isRecord(value) &&
    isPositiveInteger(value.deployment_id) &&
    isNullableString(value.sha_from) &&
    isString(value.sha_to) &&
    isString(value.result) &&
    isBoolean(value.needs_host_action) &&
    isIsoTimestamp(value.occurred_at) &&
    isPullRequestList(value.pull_requests)
  );
}

/** `value`が"deployments"ビューの結果(反映の配列)の形か。 */
export const isDeploymentHistory: Guard<DeploymentEntry[]> =
  isArrayOf(isDeploymentEntry);
