// 止まったwork itemを手動で再開するscript。`failed`・`needs_human`・
// `expired`・`blocked`・`approved`から再開でき、再開するフローと遷移先の
// 状態は種別で決まる(`computeRestartPlan`)。状態の変更はここで読んだ状態を
// 前提にした比較交換なので、並行して状態が変わったら上書きせず再開をやめる。
//
// どの種別もラベルを付け直さない。トリガーラベル(Issueは`factory`、
// PRは`factory:review`・`factory:fix`)は取得時に一度だけ消費し、
// 自動では付け直さない。状態は`work_items.status`にだけあり、再開した
// PRのwork itemは、ラベルではなく`poll_prs.ts`の`listTrackedPrs`(DBを参照)が
// 見つけ直す。したがって再開はフローを直接起動するだけで、GitHubには
// 何の副作用も無い。新しいサイクルを始めるのは、人がラベルを付け直したときだけ。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  getWorkItem,
  latestRequirementsApproval,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { IMPLEMENT_FLOW_PATH } from "./lib/implement_loop.ts";
import { isRequirementsApprovedForAttempt } from "./lib/implement_support.ts";
import { isOneOf, type WorkItem, type WorkItemStatus } from "./lib/types.ts";

const RESTARTABLE_STATUSES = [
  "failed",
  "needs_human",
  "expired",
  "blocked",
  "approved",
] as const;

export type RestartPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/**
 * 再開先を決めるための文脈。どちらも`main`が計算する。
 * `implementReady`は、最新の要件承認が現在の`attempt`に対して承認済みか。
 * `implementEnabled`は`factory_config.implement_enabled`の値。
 */
export type RestartContext = {
  readonly implementReady: boolean;
  readonly implementEnabled: boolean;
};

/**
 * 再開できるwork itemについて、戻す状態と起動するフローを決める。
 * issueは、要件が現在の`attempt`で承認済みで`implement_enabled`が有効なら
 * implementフロー、そうでなければpipelineフローで再開する。
 * pr_reviewとpr_fixは同名のフローで再開する。
 * 次の場合は例外を投げる。
 * - `workItem.status`が再開できる状態でない。
 * - issueの要件が承認済みだが、`implement_enabled`が無効(状態を問わない)。
 * - `approved`のissueの最新の要件承認が`attempt`と合わない。
 * - auditである(監査は再開しない)。
 */
export function computeRestartPlan(
  workItem: Pick<WorkItem, "id" | "status" | "kind" | "attempt">,
  context: RestartContext,
): RestartPlan {
  if (!isOneOf(workItem.status, RESTARTABLE_STATUSES)) {
    throw new Error(
      `retry_work_item: work item ${workItem.id} has status "${workItem.status}", not restartable (must be one of ${RESTARTABLE_STATUSES.join(", ")})`,
    );
  }

  switch (workItem.kind) {
    case "issue":
      if (context.implementReady && context.implementEnabled) {
        return {
          toStatus: "implementing",
          flowPath: IMPLEMENT_FLOW_PATH,
          args: { work_item_id: workItem.id },
        };
      }
      // 要件が承認済みでimplementフローが無効のとき、pipelineで再開すると
      // 人が承認した要件を作り直してしまう。状態を問わず拒否し、
      // 進め方をエラーで伝える。
      if (context.implementReady) {
        throw new Error(
          `retry_work_item: work item ${workItem.id} has approved requirements, but implement_enabled is false; enable it to restart the implement flow`,
        );
      }
      if (workItem.status === "approved") {
        throw new Error(
          `retry_work_item: work item ${workItem.id} is approved but its latest requirements approval does not match attempt ${workItem.attempt}; nothing to restart`,
        );
      }
      return {
        toStatus: "requirements_generating",
        flowPath: "f/factory/pipeline",
        args: { work_item_id: workItem.id, attempt: workItem.attempt + 1 },
      };
    case "pr_review":
      return {
        toStatus: "reviewing",
        flowPath: "f/factory/pr_review",
        args: { work_item_id: workItem.id },
      };
    case "pr_fix":
      return {
        toStatus: "fixing",
        flowPath: "f/factory/pr_fix",
        args: { work_item_id: workItem.id },
      };
    case "audit":
      throw new Error(
        `retry_work_item: work item ${workItem.id} is an audit; audits are not restartable (the next weekly audit covers the failed period, or use 今すぐ監査 in the Console)`,
      );
  }
}

export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly flow_job_id: string;
};

export async function main(work_item_id: number): Promise<RetryWorkItemResult> {
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }

  const implementReady =
    workItem.kind === "issue" &&
    isRequirementsApprovedForAttempt(
      await latestRequirementsApproval(work_item_id),
      workItem.attempt,
    );
  const plan = computeRestartPlan(workItem, {
    implementReady,
    implementEnabled: config.implement_enabled,
  });

  const moved = await updateStatusIfCurrent(
    work_item_id,
    workItem.status,
    plan.toStatus,
    `retry_work_item: restarted from ${workItem.status}`,
  );
  if (!moved) {
    throw new Error(
      `retry_work_item: work item ${work_item_id} is no longer "${workItem.status}"; not restarted`,
    );
  }

  const flowJobId = await wmill.runFlowAsync(plan.flowPath, plan.args);
  await setFlowJobId(work_item_id, flowJobId);

  return { ok: true, status: plan.toStatus, flow_job_id: flowJobId };
}
