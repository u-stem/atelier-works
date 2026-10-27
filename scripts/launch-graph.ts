// flowを起動する辺の表。文書のフローの表の起動元と、契約テストの正本になる。
// Windmillの資産ではないので、f/には置かない。
// 表が実物と合っているかは、tests/scripts/launch-graph.test.tsが確かめる。

import type { ApprovalRequestKind } from "../f/factory/lib/types.ts";

/** 辺の種類。scriptがコードで起動するか、人がコードを介さずに起動するか。 */
export type LaunchKind = "script" | "human";

/**
 * flowを起動する1本の辺。
 * - `from`: kindがscriptなら、`f/factory`からの相対パスで拡張子の無いscript名(`poll_prs`、`steps/pr_fix_finish`)。
 *   kindがhumanなら、`HUMAN_OPERATIONS`のキー。
 * - `to`: 起動されるflowの名前(`pipeline`)。`f/factory/<名前>__flow`に対応する。
 */
export type LaunchEdge = {
  readonly from: string;
  readonly to: string;
  readonly kind: LaunchKind;
};

/**
 * `wmill.runFlowAsync`でflowを起動するscriptと、起動するflow。
 * 起動を包む関数(`launchPrFixFlow`など)を呼ぶscriptも、その先を数える。
 */
export const LAUNCH_EDGES: readonly LaunchEdge[] = [
  { from: "poll_issues", to: "pipeline", kind: "script" },
  { from: "poll_prs", to: "pr_review", kind: "script" },
  { from: "poll_prs", to: "pr_fix", kind: "script" },
  { from: "poll_dependabot", to: "dependabot", kind: "script" },
  { from: "watch_pr_ci", to: "pr_fix", kind: "script" },
  { from: "watch_pr_conflicts", to: "pr_fix", kind: "script" },
  { from: "audit_kickoff", to: "audit", kind: "script" },
  { from: "auto_retry_pr_review", to: "pr_review", kind: "script" },
  { from: "auto_retry_stale_image", to: "implement", kind: "script" },
  { from: "auto_retry_stale_image", to: "pr_fix", kind: "script" },
  { from: "manual_intake_submit", to: "manual_intake", kind: "script" },
  { from: "retry_work_item", to: "pipeline", kind: "script" },
  { from: "retry_work_item", to: "implement", kind: "script" },
  { from: "retry_work_item", to: "design", kind: "script" },
  { from: "retry_work_item", to: "pr_review", kind: "script" },
  { from: "retry_work_item", to: "pr_fix", kind: "script" },
  { from: "steps/requirements_apply", to: "implement", kind: "script" },
  { from: "steps/requirements_apply", to: "pipeline", kind: "script" },
  { from: "steps/requirements_apply", to: "design", kind: "script" },
  { from: "steps/design_generate", to: "pipeline", kind: "script" },
  { from: "steps/manual_intake_register", to: "pipeline", kind: "script" },
  { from: "steps/pr_fix_finish", to: "pipeline", kind: "script" },
  { from: "steps/implement_finish", to: "pipeline", kind: "script" },
  { from: "form", to: "manual_intake", kind: "human" },
];

/** コードを介さず、人がflowを起動する操作と、その表示名。 */
export const HUMAN_OPERATIONS: Readonly<Record<string, string>> = {
  form: "人がフォームから実行",
};

/**
 * Consoleの操作が起動するscriptと、その操作の名前。
 * 承認と却下は`approval_decide`が記録した後に`requirements_apply`を起動する。
 */
export const HUMAN_ENTRY_SCRIPTS: Readonly<Record<string, string>> = {
  retry_work_item: "Consoleの再実行",
  audit_kickoff: "Consoleの今すぐ監査",
  manual_intake_submit: "Consoleの新規投入",
  "steps/requirements_apply": "Consoleの承認と却下",
};

/** 文書の起動元の列に書く、辺の起点の表記を返す。 */
export function describeOrigin(edge: LaunchEdge): string {
  if (edge.kind === "human") return HUMAN_OPERATIONS[edge.from] ?? edge.from;
  const name = edge.from.split("/").at(-1) ?? edge.from;
  const entry = HUMAN_ENTRY_SCRIPTS[edge.from];
  return entry === undefined ? `\`${name}\`` : `\`${name}\`(${entry})`;
}

/**
 * 承認依頼を作るステップのscript(`f/factory`からの相対パス)と、作る依頼の種類。
 * 種類は、ステップが`insertApprovalRequest`に渡す`kind`と一致する。
 * 契約テストが、ステップのソースと突き合わせる。
 */
export const APPROVAL_STEPS: Readonly<Record<string, ApprovalRequestKind>> = {
  "steps/pipeline_request_approval": "requirements",
  "steps/design_request_approval": "design",
};

/** 承認を処理するscriptが、承認か却下かで起動するflow。 */
export type ApprovalOutcome = {
  readonly to: string;
  readonly outcome: "approve" | "reject";
};

/**
 * 承認を処理するscript(`handlerPathFor`が返すもの)ごとの、起動するflowと承認か却下か。
 * 承認の処理が起動する辺は、`LAUNCH_EDGES`のうち、ここに載るか`UNWIRED_LAUNCH_EDGES`に載るものである。
 * どちらにも無い辺があると、図の生成が失敗する。
 */
export const APPROVAL_OUTCOMES: Readonly<
  Record<string, readonly ApprovalOutcome[]>
> = {
  "steps/requirements_apply": [
    { to: "implement", outcome: "approve" },
    { to: "pipeline", outcome: "reject" },
  ],
};

/**
 * `LAUNCH_EDGES`にあるが、本番では起動しない辺。図には描かない。
 * 設計の承認の反映は、`requirements_apply`が設計flowを起動する配線を開けるまで動かない。
 * 開けたときは、`flows_data_contract.test.ts`が落ちるので、ここから外して`APPROVAL_OUTCOMES`に移す。
 */
export const UNWIRED_LAUNCH_EDGES: readonly LaunchEdge[] = [
  { from: "steps/requirements_apply", to: "design", kind: "script" },
];
