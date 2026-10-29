// Factoryがブランチを引き継ぐ作業項目の状態の述語と、PRのブランチから作業項目を引く照合。

import type { WorkItem, WorkItemStatus } from "./types.ts";

/** 照合に使う作業項目の部分。 */
export type BranchWorkItem = Pick<
  WorkItem,
  "kind" | "owner" | "repo" | "status"
>;

export function isBranchHeldForFixRounds(
  _status: WorkItemStatus | null,
): boolean {
  return false;
}

export function isBranchGuardedStatus(_status: WorkItemStatus | null): boolean {
  return false;
}

export function isDesignStage(_status: WorkItemStatus | null): boolean {
  return false;
}

export function matchBranchWorkItem(
  _item: BranchWorkItem | null,
  _owner: string,
  _repo: string,
): WorkItemStatus | null {
  return null;
}

export async function readBranchItemStatus(
  _target: { headRef: string; owner: string; repo: string },
  _getWorkItem: (id: number) => Promise<BranchWorkItem | null>,
): Promise<WorkItemStatus | null> {
  return null;
}
