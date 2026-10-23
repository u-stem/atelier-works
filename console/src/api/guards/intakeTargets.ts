// console_queryの"intake_targets"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`IntakeTarget`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_intake_targets_contract.test.ts`が落ちる。

import { isArrayOf, isRecord, isString } from "./primitives.ts";

/** 手動投入で選べるリポジトリ。 */
export type IntakeTarget = {
  readonly owner: string;
  readonly repo: string;
};

function isIntakeTarget(value: unknown): value is IntakeTarget {
  return isRecord(value) && isString(value.owner) && isString(value.repo);
}

export const isIntakeTargets = isArrayOf(isIntakeTarget);
