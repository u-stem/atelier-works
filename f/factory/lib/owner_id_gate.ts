// 仮の実装。次のコミットで`poll_support.ts`から本体を移す。
import type { NoticeRecord } from "./types.ts";

export const OWNER_ID_MISMATCH_KIND = "";

export function ownerIdMismatchMessage(
  _name: string,
  _expectedId: number,
  _actualId: number,
): string {
  return "";
}

export function ownerNotFoundMessage(
  _name: string,
  _expectedId: number,
): string {
  return "";
}

export type OwnerIdGateDeps = {
  readonly getAccountId: (name: string) => Promise<number>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

export async function gateOwnerId(
  _owner: { readonly name: string; readonly id?: number },
  _deps: OwnerIdGateDeps,
): Promise<boolean> {
  return false;
}
