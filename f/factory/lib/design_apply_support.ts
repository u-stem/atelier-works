// 設計の承認の反映(`steps/design_apply.ts`)が使う純関数と、固定の注記。
// 入出力は行わず、単体テストのためにすべての関数を公開する。
// 承認の照合の実体は`approval_gate.ts`にあり、ここはその呼び出しと、却下の行き先の決定だけを持つ。

import {
  designApprovalVerdict,
  designGateReason,
  isRequirementsApprovedForAttempt,
  type RequirementsApprovalForGate,
} from "./approval_gate.ts";
import { designNoApprovalReason } from "./design_template.ts";
import type { ApprovalRequest, DesignApprovalRef, WorkItem } from "./types.ts";

/**
 * 設計の却下を受けて設計を作り直すときの、遷移の注記。
 * 人の却下の理由は長さの上限が無いので、遷移の記録(Consoleの履歴と通知に流れる)には入れず、固定の文にする。
 * 人の理由は承認依頼に残り、設計フローの入力と再実行が読む。
 * 理由の表(`status_reason`の訳)の対象外なので、名前を`_NOTE`にしている。
 */
export const DESIGN_REGENERATING_NOTE = "design rejected; regenerating";

/**
 * 設計の却下のとき、Issueが取り込み時点から変わっていて、要件定義の生成へ戻す遷移の注記。
 * 固定の文にする理由は`DESIGN_REGENERATING_NOTE`と同じ。
 */
export const DESIGN_ISSUE_CHANGED_NOTE =
  "design rejected; the issue changed since intake";

export type DesignApplyClassification =
  | { readonly kind: "no_op"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "needs_human"; readonly reason: string }
  | { readonly kind: "proceed"; readonly issueNumber: number };

/**
 * 依頼と作業項目から、反映を進めてよいかを判定する。上から順に調べ、最初に当たったものを返す。副作用は無い。
 * - 作業項目が`awaiting_design_approval`でない(二重実行、期限切れの後、再実行の後、取り消し、終端): `no_op`。
 * - 作業項目に`issue_number`が無い: `invalid`(作業項目の不整合で、呼び出し側が例外にする)。
 * - 依頼の状態が`approved`でも`rejected`でもない(`pending`、`expired`。期限切れの走査との競合): `no_op`。
 * `latest`(作業項目の最新の設計の承認の依頼)を渡したときは、さらに調べる。省略すると調べない。
 * - 最新の依頼のIDがこの依頼と違う(古い依頼)、または最新の依頼が無い: `no_op`。今の依頼の判断を待つ作業項目を動かさない。
 * - IDが同じで、依頼の`payload.design_attempt`が無い・整数でない・作業項目と違う: `needs_human`。
 *   承認の記録が書き換えられたか壊れていて、承認としても却下としても扱えない。
 */
export function classifyDesignApply(input: {
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
  const { request, workItem, latest } = input;
  if (workItem.status !== "awaiting_design_approval") {
    return {
      kind: "no_op",
      reason: "work item is not awaiting_design_approval",
    };
  }
  const issueNumber = workItem.issue_number;
  if (issueNumber === null) {
    return { kind: "invalid", reason: "work item has no issue_number" };
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    return { kind: "no_op", reason: "approval request is not decided" };
  }
  if (latest !== undefined) {
    if (latest === null || latest.approval_request_id !== request.id) {
      return {
        kind: "no_op",
        reason: "approval request is not the latest design request",
      };
    }
    if (latest.payload_design_attempt !== workItem.design_attempt) {
      return {
        kind: "needs_human",
        reason: designGateReason(
          { kind: "inconsistent" },
          workItem.design_attempt,
        ),
      };
    }
  }
  return { kind: "proceed", issueNumber };
}

export type DesignApprovedJudgment =
  | { readonly kind: "ok" }
  | { readonly kind: "needs_human"; readonly reason: string };

/**
 * 承認を反映してよいかを、実装の関門と同じ照合で判定する。副作用は無い。
 * 1. 要件定義が現在の`attempt`で承認済みでなければ、`designNoApprovalReason`で止める。
 * 2. 設計の承認が`designApprovalVerdict`を通らなければ、`designGateReason`で止める。
 * 要件定義が無効なのに設計の承認待ちにいる、承認の行が書き換えられた、という異常の経路なので、
 * 自動で戻さず、人の対応待ちにする。
 */
export function judgeDesignApproved(input: {
  readonly workItem: Pick<WorkItem, "attempt" | "design_attempt">;
  readonly requirementsApproval: RequirementsApprovalForGate | null;
  readonly designApproval: DesignApprovalRef | null;
}): DesignApprovedJudgment {
  const { workItem, requirementsApproval, designApproval } = input;
  if (
    requirementsApproval === null ||
    !isRequirementsApprovedForAttempt(requirementsApproval, workItem.attempt)
  ) {
    return {
      kind: "needs_human",
      reason: designNoApprovalReason(workItem.attempt),
    };
  }
  const verdict = designApprovalVerdict(designApproval, {
    attempt: workItem.attempt,
    designAttempt: workItem.design_attempt,
    requirementDraftId: requirementsApproval.draft_id,
  });
  if (verdict.kind === "ok") return { kind: "ok" };
  return {
    kind: "needs_human",
    reason: designGateReason({ kind: verdict.kind }, workItem.design_attempt),
  };
}

/** Issueを取り込み時点と比べた結果。`unavailable`は読めなかったとき。 */
export type IssueVerdictForRejection = "changed" | "unchanged" | "unavailable";

export type DesignRejectionRoute =
  | "return_to_requirements"
  | "regenerate"
  | "needs_human";

/**
 * 今回の却下を反映すると、反映できた却下の数が上限に達するかを返す。
 * 今回の却下は比較交換が成功するまで遷移の記録に無いので、数に1を足して比べる。
 * 実装から設計へ戻す経路も、同じ関数で上限を判定する。
 */
export function isDesignRejectionExhausted(
  appliedRejections: number,
  maxDesignAttempts: number,
): boolean {
  return appliedRejections + 1 >= maxDesignAttempts;
}

/**
 * 設計の却下の行き先を決める。副作用は無い。
 * - Issueが取り込み時点から変わっている: 数と上限に依らず、要件定義の生成へ戻す。
 *   上限に達していても人の対応待ちで止めず、要件定義へ戻して設計の数を0に戻すほうが出口になる。
 * - 変わっていない、または読めなかった: 反映できた却下の数が上限に達していれば`needs_human`、そうでなければ設計を作り直す。
 *   読めないことを理由に止めても出口にならないので、変わっていないものとして進める。
 */
export function decideDesignRejection(input: {
  readonly issue: IssueVerdictForRejection;
  readonly appliedRejections: number;
  readonly maxDesignAttempts: number;
}): DesignRejectionRoute {
  if (input.issue === "changed") return "return_to_requirements";
  return isDesignRejectionExhausted(
    input.appliedRejections,
    input.maxDesignAttempts,
  )
    ? "needs_human"
    : "regenerate";
}

/**
 * 要件定義の生成へ戻すときの、`pipeline`フローの入力を返す。
 * `attempt`は作業項目の値に1を足す。`feedback`は人の却下の理由で、空なら含めない。
 */
export function designRejectionPipelineInput(
  item: Pick<WorkItem, "id" | "attempt">,
  feedback: string,
): {
  readonly work_item_id: number;
  readonly attempt: number;
  readonly feedback?: string;
} {
  const base = { work_item_id: item.id, attempt: item.attempt + 1 };
  return feedback.length === 0 ? base : { ...base, feedback };
}
