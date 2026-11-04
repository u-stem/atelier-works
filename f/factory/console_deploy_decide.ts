// Factory Consoleから、保護パスの変更を含む反映を承認か却下するscript。
//
// 判断する主体は人で、操作者はジョブのWindmill実行文脈から導く(`deriveApprover`)。導けないときは何も記録せずに断る。
// 判断は承認の表の部品(`decideDeployApproval`)だけが書く。判断できるのは、最後に成功した反映より後の、最も新しい承認待ちの版だけである。
// 操作の記録(`factory.console_actions`)は、判断の前に`attempted`の行を入れ、後で結果を更新する。行を入れられなければ、判断せずに断る。
// 判断を書けたら、承認のときだけ、その版の承認を待つ通知を解決する。判断は情報の通知に残す。どちらに失敗しても判断は取り消さない。
// 承認した版は、次の`self_update`(2分ごと)が反映する。却下した版は、mainへ戻すPRがマージされるまで反映されない。
// 却下では要対応の通知を残す。却下した版は承認待ちの一覧に出ず、版の食い違いの通知も抑止されるので、
// 通知を解決すると、反映が止まったままなのに要対応が消える。戻すPRの反映(`deployed_sha`が進む)か、
// 新しい版の依頼が、既存の経路で通知を解決する。
//
// Console用workerで動くので、どのsecret変数も読まず、Discordにも送らない。

import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  runRecordedAs,
} from "./lib/console_actions.ts";
import {
  addNoticeUnlessUnresolved,
  defaultSqlClient,
  resolveUnresolvedNoticesByPrefix,
} from "./lib/db.ts";
import {
  DEPLOY_APPROVAL_DECIDED_NOTICE_KIND,
  DEPLOY_APPROVAL_NOTICE_KIND,
  type DeployApprovalDecision,
  decideDeployApproval,
  deployApprovalNoticePrefix,
  isDeploySha,
} from "./lib/deploy_approvals.ts";
import { logger } from "./lib/log.ts";
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

/**
 * 判断の結果。`notice`は判断の情報の通知を残せたか。`action_audit`は操作の記録を更新できたか。
 */
export type DeployDecideResult =
  | { readonly refused: true; readonly reason: DeployDecideRefusalReason }
  | {
      readonly refused: false;
      readonly sha: string;
      readonly decision: DeployApprovalDecision;
      readonly notice: "recorded" | "failed";
      readonly action_audit: ActionAudit;
    };

/** `decideDeployRecorded`が使う外部の操作。テストでは差し替える。 */
export type DeployDecideDeps = {
  /** 操作者。導けなければ例外を投げる。 */
  readonly deriveApprover: () => string;
  /** 承認待ちの最新の依頼を決めたら`true`、決められなければ`false`を返す。 */
  readonly decide: (
    sha: string,
    decision: DeployApprovalDecision,
    decidedBy: string,
  ) => Promise<boolean>;
  /** 版`sha`の承認を待つ通知を解決する。承認のときだけ呼ぶ。 */
  readonly resolveRequiredNotice: (
    sha: string,
    resolvedBy: string,
  ) => Promise<unknown>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
};

const DECISION_BY_INPUT: ReadonlyMap<string, DeployApprovalDecision> = new Map([
  ["approve", "approved"],
  ["reject", "rejected"],
]);

/** 通知の本文とログに載せる操作者の文字数の上限。 */
const OPERATOR_DISPLAY_MAX = 100;

function refuse(reason: DeployDecideRefusalReason): DeployDecideResult {
  return { refused: true, reason };
}

/** 判断の情報の通知の本文。版と判断と操作者で決まり、却下ではその後の戻し方を添える。 */
export function decidedNoticeMessage(
  sha: string,
  decision: DeployApprovalDecision,
  operator: string,
): string {
  const verb = decision === "approved" ? "承認" : "却下";
  const after =
    decision === "approved"
      ? "次の自己更新(2分ごと)が反映します"
      : "mainへ戻すPRがマージされるまで、反映は止まったままです";
  return `反映の判断: 版 ${sha}を${verb}しました(操作者: ${operator.slice(0, OPERATOR_DISPLAY_MAX)})。${after}`;
}

/**
 * 版`sha`の反映を、操作者として承認か却下する。`decisionInput`は`approve`か`reject`。
 * 入力が不正、操作者を導けない、操作の記録を入れられない、承認待ちでないときは、理由つきで断る(例外ではない)。
 * 判断の書き込みが例外を投げたときは、操作の記録を`failed`にして投げ直す。
 */
export async function decideDeployRecorded(
  sha: string,
  decisionInput: string,
  deps: DeployDecideDeps,
  sql: ActionSqlClient,
): Promise<DeployDecideResult> {
  if (!isDeploySha(sha)) return refuse("invalid_sha");
  const decision = DECISION_BY_INPUT.get(decisionInput);
  if (decision === undefined) return refuse("invalid_decision");
  let operator: string;
  try {
    operator = deps.deriveApprover();
  } catch {
    return refuse("actor_unknown");
  }

  const recorded = await runRecordedAs(
    () => operator,
    {
      action: "deploy_decide",
      target: `deploy:${sha}`,
      changes: { sha, decision },
    },
    async () => {
      const decided = await deps.decide(sha, decision, operator);
      return decided
        ? {
            outcome: "succeeded" as const,
            changes: { status: decision },
            value: true,
          }
        : {
            outcome: "failed" as const,
            changes: { status: "not_pending" },
            value: false,
          };
    },
    { sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) return refuse("audit_unavailable");
  if (!recorded.value) return refuse("not_pending");

  if (decision === "approved") {
    try {
      await deps.resolveRequiredNotice(sha, operator);
    } catch {
      deps.warn(
        "console_deploy_decide: could not resolve the required notice",
        { sha },
      );
    }
  }
  let notice: "recorded" | "failed" = "recorded";
  try {
    await deps.addNotice({
      kind: DEPLOY_APPROVAL_DECIDED_NOTICE_KIND,
      message: decidedNoticeMessage(sha, decision, operator),
    });
  } catch {
    notice = "failed";
    deps.warn("console_deploy_decide: could not record the decision notice", {
      sha,
    });
  }
  return {
    refused: false,
    sha,
    decision,
    notice,
    action_audit: recorded.audit,
  };
}

/** Consoleから版`sha`の反映を承認か却下する。操作者はジョブの実行文脈から導く。 */
export async function main(
  sha: string,
  decision: string,
): Promise<DeployDecideResult> {
  const log = logger("console_deploy_decide");
  const result = await decideDeployRecorded(
    sha,
    decision,
    {
      deriveApprover: () =>
        deriveApprover({
          WM_USERNAME: process.env.WM_USERNAME,
          WM_EMAIL: process.env.WM_EMAIL,
        }),
      decide: (target, verdict, decidedBy) =>
        decideDeployApproval(target, verdict, decidedBy, defaultSqlClient),
      resolveRequiredNotice: (target, resolvedBy) =>
        resolveUnresolvedNoticesByPrefix(
          DEPLOY_APPROVAL_NOTICE_KIND,
          deployApprovalNoticePrefix(target),
          resolvedBy,
        ),
      addNotice: (record) => addNoticeUnlessUnresolved(record),
      warn: (message, fields) => {
        log.warn(message, fields);
      },
    },
    defaultSqlClient,
  );
  log.info(
    "deploy decision finished",
    result.refused
      ? { refused: true, reason: result.reason }
      : {
          sha: result.sha,
          decision: result.decision,
          notice: result.notice,
          action_audit: result.action_audit,
        },
  );
  return result;
}
