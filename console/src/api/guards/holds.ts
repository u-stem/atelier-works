// console_holdsの応答の型と型ガード。
// 型は`f/factory/lib/console_holds_support.ts`の`HoldsSnapshot`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_holds_contract.test.ts`が落ちる。

import type { Guard } from "./primitives.ts";

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

export type HoldsSnapshot = {
  readonly holds: HoldsRead;
  readonly freezes: FreezesRead;
};

export const isHoldsSnapshot: Guard<HoldsSnapshot> = (
  _value: unknown,
): _value is HoldsSnapshot => false;
