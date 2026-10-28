// レビュー回のPRの修正に、親のIssueの承認済みの設計書を渡すかを決める。

import type {
  DesignGateDeps,
  RequirementsApprovalForGate,
} from "./approval_gate.ts";
import type { WorkItem } from "./types.ts";

/** `loadParentDesignForFix`が読む親の作業項目の列。 */
export type ParentForDesign = Pick<
  WorkItem,
  "id" | "owner" | "repo" | "status" | "attempt" | "design_attempt"
>;

export type FixDesignDeps = {
  readonly getWorkItem: (id: number) => Promise<ParentForDesign | null>;
  readonly latestRequirementsApproval: (
    workItemId: number,
  ) => Promise<RequirementsApprovalForGate | null>;
  readonly latestDesignApproval: DesignGateDeps["latestDesignApproval"];
  readonly getDesignDraft: DesignGateDeps["getDesignDraft"];
  readonly warn: DesignGateDeps["warn"];
};

export type FixDesignArgs = {
  readonly designEnabled: boolean;
  readonly reviewRound: boolean;
  readonly parentWorkItemId: number | null;
  readonly pr: {
    readonly owner: string;
    readonly repo: string;
    readonly headRef: string;
  };
};

/** 承認済みの設計書の本文を返す。渡さないときは`null`。 */
export async function loadParentDesignForFix(
  _deps: FixDesignDeps,
  _args: FixDesignArgs,
): Promise<string | null> {
  return null;
}
