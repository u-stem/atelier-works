// レビュー回のPRの修正に、親のIssueの承認済みの設計書を渡すかを決める。
// 渡すのは、設計工程が有効で、Factoryのブランチのレビュー回で、親が承認済みの設計を持つときだけである。
// それ以外は設計書なしに降格し、設計書なしのスキーマとプロンプトで動く。
// 判定そのものはDBを読まず、読み取りは依存として受け取る。本番の依存は`fixDesignDepsFromDb`が組む。

import {
  type DesignGateDeps,
  designGate,
  isRequirementsApprovedForAttempt,
  type RequirementsApprovalForGate,
} from "./approval_gate.ts";
import {
  getDesignDraft,
  getWorkItem,
  latestDesignApproval,
  latestRequirementsApproval,
} from "./db.ts";
import { parseImplementBranchWorkItemId, type WorkItem } from "./types.ts";

/** `loadParentDesignForFix`が読む親の作業項目の列。 */
export type ParentForDesign = Pick<
  WorkItem,
  "id" | "owner" | "repo" | "status" | "attempt" | "design_attempt"
>;

export type FixDesignDeps = {
  readonly getWorkItem: (id: number) => Promise<ParentForDesign | null>;
  /** 作業項目の最新の要件定義の承認。 */
  readonly latestRequirementsApproval: (
    workItemId: number,
  ) => Promise<RequirementsApprovalForGate | null>;
  readonly latestDesignApproval: DesignGateDeps["latestDesignApproval"];
  readonly getDesignDraft: DesignGateDeps["getDesignDraft"];
  /** `fields`は本文を含まない項目だけにする。設計書の本文を、ログへ流さないためである。 */
  readonly warn: DesignGateDeps["warn"];
};

export type FixDesignArgs = {
  /** `config.design_enabled`。偽のとき、何も読まずに設計書なしにする。 */
  readonly designEnabled: boolean;
  /** レビュー回か。CI回と競合回には設計書を渡さない。 */
  readonly reviewRound: boolean;
  readonly parentWorkItemId: number | null;
  readonly pr: {
    readonly owner: string;
    readonly repo: string;
    /** PRのheadブランチ。 */
    readonly headRef: string;
  };
};

/**
 * レビュー回のPRの修正に渡す、親の承認済みの設計書の本文を返す。渡さないときは`null`(設計書なし)。
 * 次の順に判定し、どれかに当たれば`null`を返す。
 * 1. 設計工程が無効: 何も読まない。
 * 2. レビュー回でない(CI回か競合回)。
 * 3. 親が無い、または親の行が無い。
 * 4. PRのheadがFactoryの実装のブランチで、その作業項目が親であり、親と同じownerとrepoである。
 *    人が書いたPR(`Closes #N`で親に結んだもの)は、設計書を渡す相手ではないので降格する。
 * 5. 親が`pr_open`でない。設計の最中や実装中の親の設計書は、今のPRと食い違いうる。
 * 6. 親の最新の要件定義の承認が、親の今の`attempt`の承認でない。
 * 7. 実装の関門(`designGate`)が止める。止めた理由は、本文を含まない警告に残す。
 * 承認済みの設計書は、関門が整えた本文で、信頼できない入力として囲みに入れて渡す。
 * 降格した実行は、設計書なしのスキーマ、プロンプト、出力の検査で動く。
 */
export async function loadParentDesignForFix(
  deps: FixDesignDeps,
  args: FixDesignArgs,
): Promise<string | null> {
  if (!args.designEnabled) return null;
  if (!args.reviewRound) return null;
  if (args.parentWorkItemId === null) return null;
  const parent = await deps.getWorkItem(args.parentWorkItemId);
  if (parent === null) return null;
  if (
    parseImplementBranchWorkItemId(args.pr.headRef) !== parent.id ||
    parent.owner !== args.pr.owner ||
    parent.repo !== args.pr.repo
  ) {
    return null;
  }
  if (parent.status !== "pr_open") return null;
  const requirements = await deps.latestRequirementsApproval(parent.id);
  if (
    requirements === null ||
    !isRequirementsApprovedForAttempt(requirements, parent.attempt)
  ) {
    return null;
  }
  const gate = await designGate(
    {
      designEnabled: true,
      workItem: parent,
      requirementsApproval: requirements,
    },
    deps,
  );
  if (gate.kind === "pass") return gate.markdown;
  if (gate.kind === "stop") {
    deps.warn("the design of the parent was not handed to the PR fix", {
      work_item_id: parent.id,
      reason: gate.reason,
    });
  }
  return null;
}

/** DBから読む本番の依存。`warn`は、呼び出し側のログに残す関数を渡す。 */
export function fixDesignDepsFromDb(
  warn: FixDesignDeps["warn"],
): FixDesignDeps {
  return {
    getWorkItem: (id) => getWorkItem(id),
    latestRequirementsApproval: (id) => latestRequirementsApproval(id),
    latestDesignApproval: (id) => latestDesignApproval(id),
    getDesignDraft: (id) => getDesignDraft(id),
    warn,
  };
}
