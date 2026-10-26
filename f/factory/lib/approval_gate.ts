// 実装の関門が読む、承認の判定。
// 関門の判定の実体を、日常的に直される共有モジュールから離し、小さく保つ。
// CI回の自動修正が書き換えられない拒否の一覧(`ci_fix_paths.ts`)に入れるためである。
// DBは読まない。判定に要る値は、呼び出し側が渡す。

import type { DesignApprovalRef } from "./types.ts";

/**
 * `approval`(`db.latestRequirementsApproval`の行か`null`)が、
 * ちょうど`attempt`回目の要件定義を承認したものかを返す。
 */
export function isRequirementsApprovedForAttempt(
  approval: { readonly status: string; readonly attempt: number } | null,
  attempt: number,
): boolean {
  return (
    approval !== null &&
    approval.status === "approved" &&
    approval.attempt === attempt
  );
}

export const DESIGN_STALE_REQUIREMENTS_REASON = "";

export const DESIGN_APPROVAL_INCONSISTENT_REASON = "";

export type DesignApprovalVerdict = {
  readonly kind: "ok" | "not_approved" | "stale_requirements" | "inconsistent";
};

export function noApprovedDesignReason(_designAttempt: number): string {
  return "";
}

export function designApprovalVerdict(
  _approval: DesignApprovalRef | null,
  _expected: {
    readonly attempt: number;
    readonly designAttempt: number;
    readonly requirementDraftId: number;
  },
): DesignApprovalVerdict {
  return { kind: "ok" };
}

export function isDesignApprovedForAttempt(
  _approval: DesignApprovalRef | null,
  _expected: {
    readonly attempt: number;
    readonly designAttempt: number;
    readonly requirementDraftId: number;
  },
): boolean {
  return false;
}

export function designGateReason(
  _verdict: DesignApprovalVerdict,
  _designAttempt: number,
): string {
  return "";
}
