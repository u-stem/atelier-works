// 設計の承認の反映(`steps/design_apply.ts`)が使う純関数と、固定の注記。

import type { RequirementsApprovalForGate } from "./approval_gate.ts";
import type { ApprovalRequest, DesignApprovalRef, WorkItem } from "./types.ts";

export const DESIGN_REGENERATING_NOTE = "";

export const DESIGN_ISSUE_CHANGED_NOTE = "";

export type DesignApplyClassification =
  | { readonly kind: "no_op"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "needs_human"; readonly reason: string }
  | { readonly kind: "proceed"; readonly issueNumber: number };

export function classifyDesignApply(_input: {
  readonly request: Pick<ApprovalRequest, "id" | "status">;
  readonly workItem: Pick<
    WorkItem,
    "status" | "issue_number" | "design_attempt"
  >;
  readonly latest?: {
    readonly approval_request_id: number;
    readonly payload_design_attempt: number | null;
  } | null;
}): DesignApplyClassification {
  return { kind: "proceed", issueNumber: 0 };
}

export type DesignApprovedJudgment =
  | { readonly kind: "ok" }
  | { readonly kind: "needs_human"; readonly reason: string };

export function judgeDesignApproved(_input: {
  readonly workItem: Pick<WorkItem, "attempt" | "design_attempt">;
  readonly requirementsApproval: RequirementsApprovalForGate | null;
  readonly designApproval: DesignApprovalRef | null;
}): DesignApprovedJudgment {
  return { kind: "ok" };
}

export type IssueVerdictForRejection = "changed" | "unchanged" | "unavailable";

export type DesignRejectionRoute =
  | "return_to_requirements"
  | "regenerate"
  | "needs_human";

export function isDesignRejectionExhausted(
  _appliedRejections: number,
  _maxDesignAttempts: number,
): boolean {
  return false;
}

export function decideDesignRejection(_input: {
  readonly issue: IssueVerdictForRejection;
  readonly appliedRejections: number;
  readonly maxDesignAttempts: number;
}): DesignRejectionRoute {
  return "regenerate";
}

export function designRejectionPipelineInput(
  _item: Pick<WorkItem, "id" | "attempt">,
  _feedback: string,
): {
  readonly work_item_id: number;
  readonly attempt: number;
  readonly feedback?: string;
} {
  return { work_item_id: 0, attempt: 0 };
}
