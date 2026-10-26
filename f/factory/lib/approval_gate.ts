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

// ---------------------------------------------------------------------------
// 設計の承認の照合
// ---------------------------------------------------------------------------

/** 設計の承認を照合する相手の、作業項目の現在の状態。 */
export type DesignApprovalExpectation = {
  /** `work_items.attempt`。 */
  readonly attempt: number;
  /** `work_items.design_attempt`。 */
  readonly designAttempt: number;
  /** 現在の`attempt`で承認済みの、最新の要件定義の承認の`draft_id`。 */
  readonly requirementDraftId: number;
};

export type DesignApprovalVerdictKind =
  | "ok"
  | "not_approved"
  | "stale_requirements"
  | "inconsistent";

export type DesignApprovalVerdict = {
  readonly kind: DesignApprovalVerdictKind;
};

/** 関門が止める判定。`ok`以外のすべて。 */
export type DesignApprovalDenial = {
  readonly kind: Exclude<DesignApprovalVerdictKind, "ok">;
};

/**
 * 設計の承認が、作業項目の現在の状態に一致するかを判定する。上から順に調べ、最初に当たったものを返す。
 * - 承認が無い、または承認済みでない: `not_approved`。
 * - 承認依頼が指す設計書が無い、依頼を作った時点の写し(`payload`)が欠けているか設計書と食い違う:
 *   `inconsistent`。承認済みの行がここに来るなら、行を書き換えられたか、別の依頼を指している。
 *   承認として扱わず、古い承認にも落とさない。
 * - 期待する設計の試行が1未満、または設計書の試行と違う: `not_approved`。
 *   要件定義へ戻って試行が0に戻った後や、却下の後で次の試行が始まった後に、古い承認を効かせない。
 * - 設計書が元にした要件定義、または依頼を作った時点の`attempt`が、現在と違う: `stale_requirements`。
 *   要件定義を作り直して試行がたまたま同じ値になっても、古い要件定義に基づく承認を効かせない。
 */
export function designApprovalVerdict(
  approval: DesignApprovalRef | null,
  expected: DesignApprovalExpectation,
): DesignApprovalVerdict {
  if (approval === null || approval.status !== "approved") {
    return { kind: "not_approved" };
  }
  const draft = approval.draft;
  if (
    draft === null ||
    approval.payload_attempt === null ||
    approval.payload_design_attempt === null ||
    approval.payload_design_attempt !== draft.design_attempt
  ) {
    return { kind: "inconsistent" };
  }
  if (
    expected.designAttempt < 1 ||
    expected.designAttempt !== draft.design_attempt
  ) {
    return { kind: "not_approved" };
  }
  if (
    draft.requirement_draft_id !== expected.requirementDraftId ||
    approval.payload_attempt !== expected.attempt
  ) {
    return { kind: "stale_requirements" };
  }
  return { kind: "ok" };
}

/** 設計の承認が、作業項目の現在の状態に一致するか。 */
export function isDesignApprovedForAttempt(
  approval: DesignApprovalRef | null,
  expected: DesignApprovalExpectation,
): boolean {
  return designApprovalVerdict(approval, expected).kind === "ok";
}

// ---------------------------------------------------------------------------
// 関門が止めるときの理由(`needs_human`の注記)
// ---------------------------------------------------------------------------

/**
 * 設計の承認が無いときの理由。`designAttempt`は`work_items.design_attempt`。
 * `steps/pr_workflow_support.ts`の理由の表が、同じ文字列を直接持つ。
 */
export function noApprovedDesignReason(designAttempt: number): string {
  return `no approved design for design attempt ${String(designAttempt)}`;
}

/** 承認済みの設計書が、承認済みの要件定義と食い違うときの理由。 */
export const DESIGN_STALE_REQUIREMENTS_REASON =
  "approved design does not match the approved requirements";

/** 設計の承認の記録が、設計書と食い違うときの理由。 */
export const DESIGN_APPROVAL_INCONSISTENT_REASON =
  "design approval record is inconsistent";

/** 関門が止める判定に対する理由を返す。 */
export function designGateReason(
  verdict: DesignApprovalDenial,
  designAttempt: number,
): string {
  switch (verdict.kind) {
    case "not_approved":
      return noApprovedDesignReason(designAttempt);
    case "stale_requirements":
      return DESIGN_STALE_REQUIREMENTS_REASON;
    case "inconsistent":
      return DESIGN_APPROVAL_INCONSISTENT_REASON;
  }
}
