// flowを起動する辺の表。文書のフローの表の起動元と、契約テストの正本になる。
// Windmillの資産ではないので、f/には置かない。
// 表が実物と合っているかは、tests/scripts/launch-graph.test.tsが確かめる。

import type { ApprovalRequestKind } from "../f/factory/lib/types.ts";
import type { Evidence } from "./launch-evidence.ts";

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
  { from: "pr_review_submit", to: "pr_review_intake", kind: "script" },
  { from: "retry_work_item", to: "pipeline", kind: "script" },
  { from: "retry_work_item", to: "implement", kind: "script" },
  { from: "retry_work_item", to: "design", kind: "script" },
  { from: "retry_work_item", to: "pr_review", kind: "script" },
  { from: "retry_work_item", to: "pr_fix", kind: "script" },
  { from: "steps/requirements_apply", to: "implement", kind: "script" },
  { from: "steps/requirements_apply", to: "pipeline", kind: "script" },
  { from: "steps/requirements_apply", to: "design", kind: "script" },
  { from: "steps/design_apply", to: "implement", kind: "script" },
  { from: "steps/design_apply", to: "pipeline", kind: "script" },
  { from: "steps/design_apply", to: "design", kind: "script" },
  { from: "steps/design_generate", to: "pipeline", kind: "script" },
  { from: "steps/manual_intake_register", to: "pipeline", kind: "script" },
  { from: "steps/manual_intake_register", to: "implement", kind: "script" },
  { from: "steps/pr_review_intake_register", to: "pr_review", kind: "script" },
  { from: "steps/pr_fix_finish", to: "pipeline", kind: "script" },
  { from: "steps/implement_finish", to: "pipeline", kind: "script" },
  { from: "steps/implement_finish", to: "design", kind: "script" },
  { from: "steps/pr_fix_finish", to: "design", kind: "script" },
  { from: "form", to: "manual_intake", kind: "human" },
  { from: "form", to: "pr_review_intake", kind: "human" },
];

/** コードを介さず、人がflowを起動する操作と、その表示名。 */
export const HUMAN_OPERATIONS: Readonly<Record<string, string>> = {
  form: "人がフォームから実行",
};

/**
 * Consoleの操作が起動するscriptと、その操作の名前。
 * 承認と却下は`approval_decide`が記録した後に、`requirements_apply`か`design_apply`を起動する。
 */
export const HUMAN_ENTRY_SCRIPTS: Readonly<Record<string, string>> = {
  retry_work_item: "Consoleの再実行",
  audit_kickoff: "Consoleの今すぐ監査",
  manual_intake_submit: "Consoleの新規投入",
  pr_review_submit: "ConsoleのPRレビューの投入",
  "steps/requirements_apply": "Consoleの承認と却下",
  "steps/design_apply": "Consoleの承認と却下",
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
 * 承認の処理が起動する辺は、`LAUNCH_EDGES`のすべてをここに載せる。
 * 載せていない辺があると、図の生成が失敗する。
 */
export const APPROVAL_OUTCOMES: Readonly<
  Record<string, readonly ApprovalOutcome[]>
> = {
  "steps/requirements_apply": [
    { to: "implement", outcome: "approve" },
    { to: "pipeline", outcome: "reject" },
    { to: "design", outcome: "approve" },
  ],
  "steps/design_apply": [
    { to: "implement", outcome: "approve" },
    { to: "pipeline", outcome: "reject" },
    { to: "design", outcome: "reject" },
  ],
};

/**
 * `LAUNCH_EDGES`にあるが、本番では起動しない辺。図の入口と出口には描かず、起動先のflowに「まだ起動されない」入口として添える。
 * 設計工程の辺は、設定で切り替わる辺として`LAUNCH_EDGES`に載せ、ここには載せない。
 * 設定と上限で決まる辺(`requirements_apply`から`implement`など)と同じく、図に印は付けない。
 * 配線の門が`config.design_enabled`の内側だけであることは、`flows_data_contract.test.ts`と`design_stage_closed.test.ts`が確かめる。
 * 今は載せる辺が無い。載せると、図の入口と出口から外れ、起動先のflowの「まだ起動されない」入口になる。
 */
export const UNWIRED_LAUNCH_EDGES: readonly LaunchEdge[] = [];

/**
 * 前のflowへ差し戻す辺。要件定義の不足(requirements_gap)ならpipelineへ、設計の不足(design_gap)ならdesignへ戻す。
 */
export type ReworkEdge = { readonly from: string; readonly to: string };

/**
 * 差し戻しのときだけ起動する辺。通常の起動と分けて描く。
 * 差し戻しは試行の上限までで、上限を超えると起動せず、人の対応待ちにする。
 * 設計の不足でdesignへ戻す辺も載せる。載せないと、designからimplementへの承認の辺と合わせて前進の辺が循環し、
 * 起動の図が段(列)を決められない。
 * 契約テストが、行き先に応じて、ステップのソースの`requirements_gap`か`design_gap`と照合する。
 */
export const REWORK_LAUNCH_EDGES: readonly ReworkEdge[] = [
  { from: "steps/design_generate", to: "pipeline" },
  { from: "steps/implement_finish", to: "pipeline" },
  { from: "steps/pr_fix_finish", to: "pipeline" },
  { from: "steps/implement_finish", to: "design" },
  { from: "steps/pr_fix_finish", to: "design" },
];

/** PRを介した関係の向き。前進は次の段へ、戻りは前のflowへ戻る。 */
export type PrRelationDirection = "forward" | "return";

/**
 * PRを介して続く1本の関係。flowの起動の辺ではなく、PRのラベルやCIの結果を定期ジョブが見て起動するものである。
 * - `from`: `f/factory`からの相対パスで拡張子の無いscript名。flowのステップのscriptでなければならない。
 * - `to`: 続くflowの名前。
 * - `trigger`: 経由の短い説明。表のソースとテストだけで使い、画面のデータには出さない。
 * - `evidence`: 関係の根拠になるソースの文字列。1つ目は`from`のscript自身にする。
 */
export type PrRelationEdge = {
  readonly from: string;
  readonly to: string;
  readonly direction: PrRelationDirection;
  readonly trigger: string;
  readonly evidence: readonly Evidence[];
};

/**
 * PRを介した関係の表。`LAUNCH_EDGES`には混ぜない(コードがflowを起動する辺ではないため)。
 * `evidence`は、ソースのコード(コメントを除く)にちょうど1か所で現れる式で、契約テストが照合する。
 * 照合が落ちたら、表か文字列を直す。
 */
export const PR_RELATION_EDGES: readonly PrRelationEdge[] = [
  {
    from: "steps/implement_finish",
    to: "pr_review",
    direction: "forward",
    trigger:
      "implement_finish labels the PR for review and poll_prs starts pr_review",
    evidence: [
      { file: "steps/implement_finish.ts", includes: "[config.review_label]" },
      {
        file: "lib/poll_support.ts",
        includes: '{ kind: "trigger_review", reason: "label"',
      },
    ],
  },
  {
    from: "steps/pr_review_post",
    to: "pr_fix",
    direction: "forward",
    trigger:
      "pr_review_post records the review, then a person labels the PR or the CI watch starts pr_fix",
    evidence: [
      {
        file: "steps/pr_review_post.ts",
        includes: "await insertReview(record);",
      },
      { file: "lib/pr_ci_fix_claim.ts", includes: 'hold("not_reviewed")' },
      {
        file: "lib/poll_support.ts",
        includes: '{ kind: "trigger_fix", removeLabel: true }',
      },
    ],
  },
  {
    from: "steps/dependabot_finish",
    to: "pr_fix",
    direction: "forward",
    trigger:
      "dependabot_finish asks a person to label the PR, and poll_prs starts pr_fix",
    evidence: [
      {
        file: "steps/dependabot_finish.ts",
        includes: "fixByHumanNextAction(run.fixLabel)",
      },
      {
        file: "lib/poll_support.ts",
        includes: '{ kind: "trigger_fix", removeLabel: true }',
      },
    ],
  },
  {
    from: "steps/pr_fix_finish",
    to: "pr_review",
    direction: "return",
    trigger:
      "after a CI fix pr_fix_finish leaves the head unrecorded, and poll_prs sees the new head and starts pr_review",
    evidence: [
      {
        file: "steps/pr_fix_finish.ts",
        includes: "await runPostPushBookkeeping(ciRound, {",
      },
      { file: "lib/ci_fix_round.ts", includes: "if (ciRound) return;" },
      {
        file: "lib/poll_support.ts",
        includes: "candidate.lastKnownHeadSha !== candidate.headSha",
      },
    ],
  },
];

/**
 * flowを起動するscriptを、別のscriptが呼ぶ関係(呼ばれるscript → 呼ぶscript)。
 * スケジュールも人の操作も持たないscriptの入口に、起動元を添えるために使う。
 * 契約テストが、呼ぶscriptのソースと照合する。
 */
export const SCRIPT_CALLERS: Readonly<Record<string, string>> = {
  auto_retry_stale_image: "self_update",
};
