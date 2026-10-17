// 凍結の状態を読み、`wmill sync push`へ渡す除外を作り、追従が済んだ行を消す手順。
// 変数の読み書きは注入された入出力で行い、`self_update`と`scripts/freeze.ts`が同じ手順を使う。

import type { FreezeState, Outcome } from "./freezes.ts";

export type FreezePorts = {
  /** 変数の値。変数が無いと確かめられたときだけ`null`を返す。読めなければ例外を投げる。 */
  readonly readVariable: () => Promise<string | null>;
  readonly writeVariable: (text: string) => Promise<void>;
  readonly now: () => Date;
};

export type FreezeInputs = {
  readonly baseExcludes: readonly string[];
  /** 実在する`*.schedule.yaml`のパス(拡張子なし)。 */
  readonly known: ReadonlySet<string>;
};

export type FrozenPushPlan = {
  readonly excludesArg: string;
  readonly excludedTargets: readonly string[];
  /** この回の開始より前に終わっていた行。pushが成功したら消す。 */
  readonly readyIds: readonly string[];
  readonly warnings: readonly string[];
};

export async function prepareFrozenPush(
  _ports: FreezePorts,
  _inputs: FreezeInputs,
): Promise<Outcome<FrozenPushPlan>> {
  return { ok: false, reason: "not implemented" };
}

export async function finishFrozenPush(
  _ports: FreezePorts,
  _readyIds: readonly string[],
): Promise<void> {}

export async function mutateFreezeState(
  _ports: FreezePorts,
  _operation: (state: FreezeState, now: Date) => Outcome<FreezeState>,
): Promise<Outcome<FreezeState>> {
  return { ok: false, reason: "not implemented" };
}

export async function loadFreezeInputs(
  _cloneDir: string,
): Promise<Outcome<FreezeInputs>> {
  return { ok: false, reason: "not implemented" };
}

export type FreezeSdk = {
  readonly getVariable: (path: string) => Promise<string>;
  readonly setVariable: (
    path: string,
    value: string,
    isSecretIfNotExist?: boolean,
    descriptionIfNotExist?: string,
  ) => Promise<void>;
  readonly VariableService: {
    readonly existsVariable: (args: {
      workspace: string;
      path: string;
    }) => Promise<boolean>;
  };
};

export function sdkFreezePorts(
  _sdk: FreezeSdk,
  _workspace: string,
  now: () => Date,
): FreezePorts {
  return {
    readVariable: async () => null,
    writeVariable: async () => {},
    now,
  };
}
