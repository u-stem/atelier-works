// 実装の関門が読む、承認の判定。
// 関門の判定の実体を、日常的に直される共有モジュールから離し、小さく保つ。
// CI回の自動修正が書き換えられない拒否の一覧(`ci_fix_paths.ts`)に入れるためである。
// DBは読まない。判定に要る値は、呼び出し側が渡す。

import {
  DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  normalizeDesignForImplement,
} from "./model_text.ts";
import type { DesignApprovalRef, DesignDraft, WorkItem } from "./types.ts";

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

// ---------------------------------------------------------------------------
// 実装の関門と、実装へ再開してよいかの判定
// ---------------------------------------------------------------------------

/** 判定が読む、要件定義の承認の行。`db.latestRequirementsApproval`の行がそのまま当てはまる。 */
export type RequirementsApprovalForGate = {
  readonly status: string;
  readonly attempt: number;
  /** 承認依頼が指す要件定義の下書きの`id`。 */
  readonly draft_id: number;
};

export type ReadyForImplementDeps = {
  readonly latestRequirementsApproval: (
    workItemId: number,
  ) => Promise<RequirementsApprovalForGate | null>;
  readonly latestDesignApproval: (
    workItemId: number,
  ) => Promise<DesignApprovalRef | null>;
};

/**
 * 実装フローで再開してよいか。再実行と自動再開と自己更新の起動の要否が、同じ判定を使う。
 * 要件定義が現在の`attempt`で承認済みで、設計が無効か、設計の承認が照合を通るときだけ真を返す。
 * 設計が無効のときは、設計の承認を読まない。
 */
export async function isReadyForImplement(
  item: Pick<WorkItem, "id" | "attempt" | "design_attempt">,
  designEnabled: boolean,
  deps: ReadyForImplementDeps,
): Promise<boolean> {
  const requirements = await deps.latestRequirementsApproval(item.id);
  if (
    requirements === null ||
    !isRequirementsApprovedForAttempt(requirements, item.attempt)
  ) {
    return false;
  }
  if (!designEnabled) return true;
  return isDesignApprovedForAttempt(await deps.latestDesignApproval(item.id), {
    attempt: item.attempt,
    designAttempt: item.design_attempt,
    requirementDraftId: requirements.draft_id,
  });
}

/** `designGate`の結果。 */
export type DesignGateResult =
  | { readonly kind: "skip" }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "pass"; readonly markdown: string };

export type DesignGateInput = {
  readonly designEnabled: boolean;
  readonly workItem: Pick<WorkItem, "id" | "attempt" | "design_attempt">;
  /** 現在の`attempt`で承認済みの、最新の要件定義の承認。 */
  readonly requirementsApproval: { readonly draft_id: number };
};

export type DesignGateDeps = {
  readonly latestDesignApproval: (
    workItemId: number,
  ) => Promise<DesignApprovalRef | null>;
  readonly getDesignDraft: (
    id: number,
  ) => Promise<Pick<
    DesignDraft,
    "work_item_id" | "design_attempt" | "requirement_draft_id" | "markdown"
  > | null>;
  /**
   * 設計書を整えて本文が変わったときに1回呼ぶ。`fields`は本文を含まない項目だけにする。
   * 設計書には秘密情報や隠れた指示が含まれうるので、本文をログに流さない。
   */
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 実装の関門の、設計の承認の判定。
 * - 設計が無効なら`skip`を返す。承認の行があっても読まず、設計書も渡さない。
 * - 設計が有効で、承認が照合を通らなければ、理由つきで`stop`を返す。
 * - 照合を通れば、承認依頼が指す設計書を読み直し、`pass`と整えた設計書の本文を返す。最新の設計書は読まない。
 *   後から保存された別の設計書が、承認済みの設計書に取って代わって実装に渡らないようにするためである。
 *   読み直した設計書が、照合した値と食い違う、または無いときは、`inconsistent`で止める。
 * 設計書は信頼できない入力を読んだClaudeの出力なので、渡す前に`normalizeDesignForImplement`を通す。
 * 整形で本文が変わったとき(切った、マスクした、結合文字を落とした、制御文字や書式文字を除いた)は、警告を1件残して止めない。
 * HTMLとリンク参照定義は除かず、文字としてそのまま渡す。
 * 設計書は要件定義より下位の入力で、切れても要件定義が優先されるためである。
 */
export async function designGate(
  input: DesignGateInput,
  deps: DesignGateDeps,
): Promise<DesignGateResult> {
  if (!input.designEnabled) return { kind: "skip" };
  const { workItem } = input;
  const approval = await deps.latestDesignApproval(workItem.id);
  const verdict = designApprovalVerdict(approval, {
    attempt: workItem.attempt,
    designAttempt: workItem.design_attempt,
    requirementDraftId: input.requirementsApproval.draft_id,
  });
  if (verdict.kind !== "ok") {
    return {
      kind: "stop",
      reason: designGateReason({ kind: verdict.kind }, workItem.design_attempt),
    };
  }
  const inconsistent: DesignGateResult = {
    kind: "stop",
    reason: DESIGN_APPROVAL_INCONSISTENT_REASON,
  };
  if (approval === null || approval.draft === null) return inconsistent;
  const draft = await deps.getDesignDraft(approval.design_draft_id);
  if (
    draft === null ||
    draft.work_item_id !== workItem.id ||
    draft.design_attempt !== approval.draft.design_attempt ||
    draft.requirement_draft_id !== approval.draft.requirement_draft_id
  ) {
    return inconsistent;
  }
  const normalized = normalizeDesignForImplement(
    draft.markdown,
    DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  );
  if (normalized.changed) {
    deps.warn(
      "the design was changed before it was handed to the implementation",
      {
        work_item_id: workItem.id,
        design_draft_id: approval.design_draft_id,
        original_chars: normalized.original_chars,
        kept_chars: normalized.kept_chars,
        truncated: normalized.truncated,
        masked: normalized.masked,
        dropped_combining: normalized.dropped_combining,
      },
    );
  }
  return { kind: "pass", markdown: normalized.text };
}
