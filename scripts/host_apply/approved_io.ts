/** 承認の記録ファイルの読み書き。 */

import type { ApprovedRecord } from "./approved_store.ts";

export type ReadApprovedResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "found"; readonly record: ApprovedRecord };

export function approvedFilePath(dir: string): string {
  return `${dir}/approved.json`;
}

export function readApproved(
  _dir: string,
  _uid: number = 0,
): ReadApprovedResult {
  return { kind: "absent" };
}

export function writeApproved(
  _dir: string,
  _record: ApprovedRecord,
  _uid: number = 0,
): void {}
