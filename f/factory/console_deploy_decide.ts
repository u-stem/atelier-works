// Factory Consoleから、保護パスの変更を含む反映を承認か却下するscript。
// 実装の前の最小のスタブで、どの入力も断る。

import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { DeployApprovalDecision } from "./lib/deploy_approvals.ts";
import type { NoticeRecord } from "./lib/types.ts";

/** 断る理由。画面は日本語の固定文に直す。 */
export const DEPLOY_DECIDE_REFUSAL_REASONS = [
  "invalid_sha",
  "invalid_decision",
  "not_pending",
  "actor_unknown",
  "audit_unavailable",
] as const;
export type DeployDecideRefusalReason =
  (typeof DEPLOY_DECIDE_REFUSAL_REASONS)[number];

export type DeployDecideResult =
  | { readonly refused: true; readonly reason: DeployDecideRefusalReason }
  | {
      readonly refused: false;
      readonly sha: string;
      readonly decision: DeployApprovalDecision;
      readonly notice: "recorded" | "failed";
      readonly action_audit: ActionAudit;
    };

export type DeployDecideDeps = {
  readonly deriveApprover: () => string;
  readonly decide: (
    sha: string,
    decision: DeployApprovalDecision,
    decidedBy: string,
  ) => Promise<boolean>;
  readonly resolveRequiredNotice: (
    sha: string,
    resolvedBy: string,
  ) => Promise<unknown>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
};

export function decidedNoticeMessage(
  _sha: string,
  _decision: DeployApprovalDecision,
  _operator: string,
): string {
  return "";
}

export function decideDeployRecorded(
  _sha: string,
  _decisionInput: string,
  _deps: DeployDecideDeps,
  _sql: ActionSqlClient,
): Promise<DeployDecideResult> {
  return Promise.resolve({ refused: true, reason: "invalid_sha" });
}

export function main(
  sha: string,
  decision: string,
): Promise<DeployDecideResult> {
  return decideDeployRecorded(sha, decision, STUB_DEPS, STUB_SQL);
}

const STUB_DEPS: DeployDecideDeps = {
  deriveApprover: () => "",
  decide: () => Promise.resolve(false),
  resolveRequiredNotice: () => Promise.resolve(0),
  addNotice: () => Promise.resolve(0),
  warn: () => undefined,
};

const STUB_SQL: ActionSqlClient = () => ({
  fetch: () => Promise.resolve([]),
  execute: () => Promise.resolve(),
});
