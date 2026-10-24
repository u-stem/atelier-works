// 保留と凍結の画面の表示を決める純関数。

import type {
  DeployFreezeRowView,
  FreezeRowView,
  FreezesRead,
  HoldRowView,
  HoldsRead,
} from "../api/guards/holds.ts";

export type ReleaseTarget =
  | { readonly kind: "hold"; readonly id: number }
  | { readonly kind: "freeze"; readonly id: string };

export type HoldCategory =
  | "merge"
  | "claim"
  | "deploy"
  | "schedule"
  | "unknown";

export type HoldItem = {
  readonly key: string;
  readonly target: ReleaseTarget;
  readonly category: HoldCategory;
  readonly kindLabel: string;
  readonly targetText: string;
  readonly reasonText: string;
  readonly holderLabel: string;
  readonly holderText: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly foreignHolder: boolean;
  readonly note: string | null;
};

export type FailureView = {
  readonly title: string;
  readonly detail: string;
  readonly reason: string;
  readonly reasonOpen: boolean;
  readonly hint: string | null;
  readonly retry: boolean;
};

export function holdItems(_rows: readonly HoldRowView[]): HoldItem[] {
  return [];
}

export function scheduleFreezeItems(
  _rows: readonly FreezeRowView[],
): HoldItem[] {
  return [];
}

export function deployFreezeItems(
  _rows: readonly DeployFreezeRowView[],
): HoldItem[] {
  return [];
}

export function isExpiredAt(_expiresAt: string, _nowMs: number): boolean {
  return false;
}

export function remainingText(_expiresAt: string, _nowMs: number): string {
  return "";
}

export function effectText(_item: HoldItem, _otherDeployCount: number): string {
  return "";
}

export function otherActiveDeployCount(
  _items: readonly HoldItem[],
  _item: HoldItem,
  _nowMs: number,
): number {
  return 0;
}

export function foreignHolderWarning(_item: HoldItem): string | null {
  return null;
}

export function holdsFailureView(
  _failure: Extract<HoldsRead, { ok: false }>,
): FailureView {
  return {
    title: "",
    detail: "",
    reason: "",
    reasonOpen: false,
    hint: null,
    retry: false,
  };
}

export function freezesFailureView(
  _failure: Extract<FreezesRead, { ok: false }>,
): FailureView {
  return {
    title: "",
    detail: "",
    reason: "",
    reasonOpen: false,
    hint: null,
    retry: false,
  };
}
