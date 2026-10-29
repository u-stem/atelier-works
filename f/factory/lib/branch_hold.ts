// Factoryがブランチを引き継ぐ作業項目の状態の述語と、PRのブランチから作業項目を引く照合。
// PRのブランチ(`factory/issue-<N>-wi-<id>`)が指すIssueの作業項目が、要件定義から実装までの間にあるあいだは、
// 設計や実装がそのブランチへpushする。人や自動修正がpushすると、食い違うためである。
// 述語は何も読まない。作業項目の読み取りは呼び出し側が注入する。

import {
  parseImplementBranchWorkItemId,
  type WorkItem,
  type WorkItemStatus,
} from "./types.ts";

/** 照合に使う作業項目の部分。 */
export type BranchWorkItem = Pick<
  WorkItem,
  "kind" | "owner" | "repo" | "status"
>;

/** 設計の段階の状態。 */
const DESIGN_STAGE_STATUSES: readonly WorkItemStatus[] = [
  "designing",
  "awaiting_design_approval",
];

/** 承認の後、実装が動いている状態と、動き出す直前の状態。 */
const IMPLEMENT_STAGE_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "implementing",
];

/** 要件定義の段階の状態。PRの修正から要件定義へ戻した後に、承認を待つ間も含む。 */
const REQUIREMENTS_STAGE_STATUSES: readonly WorkItemStatus[] = [
  "requirements_generating",
  "awaiting_approval",
];

/**
 * 設計の段階(`designing`、`awaiting_design_approval`)か。
 * `pr_review`の準備が使う。作業項目が引けないとき(`null`)は偽である。
 */
export function isDesignStage(status: WorkItemStatus | null): boolean {
  return status !== null && DESIGN_STAGE_STATUSES.includes(status);
}

/**
 * 準備のガードが止める4状態(設計の段階の2状態と、`approved`、`implementing`)か。
 * 要件定義の段階の2状態は含めない。既存のレビュー回の挙動を変えないためである。
 */
export function isBranchGuardedStatus(status: WorkItemStatus | null): boolean {
  return (
    status !== null &&
    (isDesignStage(status) || IMPLEMENT_STAGE_STATUSES.includes(status))
  );
}

/**
 * 競合回とCI回の起動と、競合の通知が止まる6状態(要件定義の段階の2状態と、準備のガードの4状態)か。
 * 要件定義の段階を含めるのは、PRの修正から要件定義へ戻した後、承認を待つ間に回が起動し、
 * 承認の後の実装の準備が、終端でない回で止まる経路を塞ぐためである。
 */
export function isBranchHeldForFixRounds(
  status: WorkItemStatus | null,
): boolean {
  return (
    status !== null &&
    (REQUIREMENTS_STAGE_STATUSES.includes(status) ||
      isBranchGuardedStatus(status))
  );
}

/**
 * ブランチから引いた作業項目が、このリポジトリのIssueの作業項目なら、その状態を返す。
 * 種類が`issue`で、所有者とリポジトリ名を小文字で比べて一致するときだけである。
 * 引けないとき(`null`、削除済み、不一致)は`null`を返し、呼び出し側は止めない。
 */
export function matchBranchWorkItem(
  item: BranchWorkItem | null,
  owner: string,
  repo: string,
): WorkItemStatus | null {
  if (item === null || item.kind !== "issue") return null;
  if (item.owner.toLowerCase() !== owner.toLowerCase()) return null;
  if (item.repo.toLowerCase() !== repo.toLowerCase()) return null;
  return item.status;
}

/**
 * PRのブランチ名が指す作業項目を読み、照合した状態を返す。
 * Factoryのブランチの形でなければ、作業項目を読まずに`null`を返す。
 * 読み取りの失敗は握らず、呼び出し側へ伝える。
 */
export async function readBranchItemStatus(
  target: { headRef: string; owner: string; repo: string },
  getWorkItem: (id: number) => Promise<BranchWorkItem | null>,
): Promise<WorkItemStatus | null> {
  const id = parseImplementBranchWorkItemId(target.headRef);
  if (id === null) return null;
  return matchBranchWorkItem(await getWorkItem(id), target.owner, target.repo);
}
