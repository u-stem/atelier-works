// 作業項目の中止について、ボタンを出すか、ロックのキー、確認のダイアログの文を決める純粋関数。
// 中止してよい種別と状態は、scriptが許可表で強制する。画面の表は、ボタンを出すかを決めるための写しで、
// backendの表との一致は`tests/scripts/console_write_contract.test.ts`が確かめる。

import { writeTargetKey } from "../api/writeLocks.ts";

/** 種別ごとに、人が中止してよい状態。`f/factory/lib/operator_cancel.ts`の`OPERATOR_CANCELLABLE_STATUSES`の写しである。 */
export const WORK_ITEM_CANCELLABLE_STATUSES: Readonly<
  Record<string, readonly string[]>
> = {
  issue: [
    "awaiting_approval",
    "awaiting_design_approval",
    "approved",
    "failed",
    "needs_human",
    "expired",
    "blocked",
  ],
  pr_review: ["failed", "needs_human", "blocked"],
  pr_fix: ["failed", "needs_human", "blocked"],
  audit: ["awaiting_approval", "failed", "needs_human"],
  dependabot: ["failed", "needs_human"],
  investigate: ["failed", "needs_human"],
};

/** 承認依頼を待つ状態。 */
const AWAITING_APPROVAL_STATUSES: readonly string[] = [
  "awaiting_approval",
  "awaiting_design_approval",
];

/** PRの1つの行として作業項目を持つ種別。中止すると、同じheadではCIの自動の修正が起動しない。 */
const PR_KINDS: readonly string[] = ["pr_review", "pr_fix", "dependabot"];

/** 人がトリガーのラベルを付けて始まる種別。 */
const LABEL_KINDS: readonly string[] = ["issue", "pr_review", "pr_fix"];

/** 種別ごとに、中止の後にFactoryが同じ対象を拾い直すかの文。 */
function pickUpLines(kind: string): string[] {
  if (kind === "issue") {
    return [
      "同じIssueは、人がトリガーのラベルを付け直すまで、Factoryが拾い直しません。",
    ];
  }
  if (LABEL_KINDS.includes(kind)) {
    return [
      "同じPRは、人がトリガーのラベルを付け直すまで、Factoryが拾い直しません。",
      "ただし、ほかの経路で見つかったPRは、headが動くと、ラベルが無くても新しいレビューが始まることがあります。",
      "作業項目の追跡だけで見ているPRは、headが動いても始まりません。",
    ];
  }
  if (kind === "dependabot") {
    return ["同じheadのdependabotのPRは、Factoryが自動で処理し直しません。"];
  }
  return ["この作業項目は、Factoryが自動では動かし直しません。"];
}

/** 種別`kind`で状態`status`の作業項目に、中止のボタンを出すか。知らない種別には出さない。 */
export function canCancelWorkItem(kind: string, status: string): boolean {
  if (!Object.hasOwn(WORK_ITEM_CANCELLABLE_STATUSES, kind)) return false;
  return WORK_ITEM_CANCELLABLE_STATUSES[kind]?.includes(status) ?? false;
}

export type WorkItemCancelInput = { readonly workItemId: number };

/**
 * 中止のロックのキー。再実行と同じ作業項目ごとのキーにする。
 * 同じ作業項目の再実行と中止を、同じタブから同時に送らないためである。
 */
export function workItemCancelKey(input: WorkItemCancelInput): string {
  return writeTargetKey("work_item", input.workItemId);
}

/**
 * 確認のダイアログに並べる文。効果、元に戻せないこと、残るもの、拾い直されない条件を書く。
 * 拾い直されない条件は、種別ごとに、実装の振る舞いに合わせて書き分ける。
 * 承認待ちのIssueには、要件定義と設計の承認依頼が期限切れになることを足す。
 * 監査の承認待ちには、Issue化の提案の依頼が残ることを足す。
 * Issueには、ブランチのPRの直す回が止まることを、PRの行には、CIと競合の直す回が止まる条件を足す。
 */
export function cancelWorkItemDialogLines(
  kind: string,
  status: string,
): string[] {
  const lines = [
    "作業項目を中止します。中止した作業項目は再開できません。",
    "ブランチとPRは残ります。要らなければ、人が閉じるか消してください。",
    ...pickUpLines(kind),
  ];
  if (AWAITING_APPROVAL_STATUSES.includes(status)) {
    lines.push(
      kind === "audit"
        ? "Issue化の提案の承認依頼は残ります。"
        : "保留中の承認依頼は期限切れになり、承認も却下もできなくなります。",
    );
  }
  if (kind === "issue") {
    lines.push(
      "このIssueのブランチのPRは、CIの失敗と競合を、Factoryが自動では直しません。",
    );
  }
  if (PR_KINDS.includes(kind)) {
    lines.push(
      "このPRのCIの失敗は、headが同じ間、Factoryが自動では直しません。",
      "このPRの競合は、次に競合が起きるまで、Factoryが自動では直しません。",
    );
  }
  return lines;
}
