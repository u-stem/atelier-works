// 止まった作業項目を手動で再開するscript。`failed`・`needs_human`・
// `expired`・`blocked`・`approved`から再開でき、再開するフローと遷移先の
// 状態は種別で決まる(`computeRestartPlan`)。状態の変更はここで読んだ状態を
// 前提にした比較交換なので、並行して状態が変わったら上書きせず再開をやめる。
// 記録済みのflowジョブがまだ動いている(キュー待ちを含む)か、状態を読めないときは
// 再開を拒否する。実装フローへの再開は比較交換でflow_job_id(リース)を空にし、
// 起動したジョブIDは空のときだけ記録する。起動の戻り値がジョブIDでなければ、
// 状態をneeds_humanに戻して例外を投げる(`launchFailureError`)。
//
// どの種別もラベルを付け直さない。トリガーラベル(Issueは`factory`、
// PRは`factory:review`・`factory:fix`)は取得時に一度だけ消費し、
// 自動では付け直さない。状態は`work_items.status`にだけあり、再開した
// PRの作業項目は、ラベルではなく`poll_prs.ts`の`listTrackedPrs`(DBを参照)が
// 見つけ直す。したがって再開はフローを直接起動するだけで、GitHubには
// 何の副作用も無い。新しいサイクルを始めるのは、人がラベルを付け直したときだけ。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  getWorkItem,
  latestRequirementsApproval,
  setFlowJobId,
  setFlowJobIdIfUnset,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "./lib/implement_loop.ts";
import { isRequirementsApprovedForAttempt } from "./lib/implement_support.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { type JobState, readJobState } from "./lib/poll_support.ts";
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
 * 再開できる作業項目について、戻す状態と起動するフローを決める。
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

/** 実装フローへの再開ならtrueを返す。そのときは比較交換でリースを空け、ジョブIDは空のときだけ記録する。 */
export function usesImplementLease(
  plan: Pick<RestartPlan, "flowPath">,
): boolean {
  return plan.flowPath === IMPLEMENT_FLOW_PATH;
}

/**
 * 記録済みのflowジョブがまだ動いているか、状態を読めなければ拒否の理由を、そうでなければnullを返す。
 * 動いている古いフローと新しいフローが同じ作業項目(実装フローなら同じworktree)を同時に書き換えないため。
 * absent(未記録・404)は拒否しない。Windmillは古い完了ジョブを消すので、拒否すると再開できなくなる。
 */
export function runningFlowRefusal(
  workItemId: number,
  flowJobId: string | null,
  job: JobState,
): string | null {
  if (flowJobId === null) return null;
  if (job.state === "running") {
    return `retry_work_item: work item ${String(workItemId)}'s flow job ${flowJobId} is still running; wait for it to finish or cancel it before restarting`;
  }
  if (job.state === "unknown") {
    return `retry_work_item: the state of work item ${String(workItemId)}'s flow job ${flowJobId} could not be read; try again later`;
  }
  return null;
}

/**
 * 再開の結果。flow_job_idは作業項目に記録したジョブIDで、別の実行が先にリースを取っていて
 * 記録しなかったときはnull(okもfalse)。started_job_idは起動したジョブのID。
 */
export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly started_job_id: string;
  readonly flow_job_id: string | null;
};

/** recordedがfalse(別の実行が先にリースを取っていた)なら、okをfalse、flow_job_idをnullにする。 */
export function retryResult(
  status: WorkItemStatus,
  startedJobId: string,
  recorded: boolean,
): RetryWorkItemResult {
  return {
    ok: recorded,
    status,
    started_job_id: startedJobId,
    flow_job_id: recorded ? startedJobId : null,
  };
}

/**
 * フローを起動できなかったときに投げる例外を作る。
 * まず`rollBack`(起動失敗の理由を注記にして`needs_human`へ戻す比較交換)を呼ぶ。
 * - 戻せたときは、起動失敗の理由を返す。
 * - `rollBack`が例外を投げたときは、その例外をマスクしてログに残し、起動失敗の理由を返す。
 *   人が見るエラーを、元の原因である起動の失敗にしておくため。
 * - `rollBack`が`false`を返したとき(別の実行がリースを持つか、作業項目が先に動いた)は、
 *   起動の応答はエラーだったが別の実行が動いていることを伝える理由を返す。
 *   フローは実際には起動していることがあり、「起動できなかった」と伝えると誤解させるため。
 */
export async function launchFailureError(
  flowPath: string,
  detail: string,
  rollBack: (reason: string) => Promise<boolean>,
  log: (message: string, fields: Record<string, unknown>) => void,
): Promise<Error> {
  const reason = `retry_work_item: ${flowPath} could not be started: ${detail}`;
  let rolledBack: boolean;
  try {
    rolledBack = await rollBack(reason);
  } catch (err) {
    log("needs_human rollback after a failed launch failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return new Error(reason);
  }
  if (rolledBack) return new Error(reason);
  return new Error(
    `retry_work_item: ${flowPath} returned an error, but another run holds the lease or the work item moved on, so it was not moved to needs_human: ${detail}`,
  );
}

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
  const refusal = runningFlowRefusal(
    work_item_id,
    workItem.flow_job_id,
    await readJobState(
      (id) =>
        wmill.JobService.getJob({
          workspace: process.env.WM_WORKSPACE ?? "",
          id,
          noLogs: true,
          noCode: true,
        }),
      workItem.flow_job_id,
      (failure) =>
        logger("retry_work_item").warn("flow job state could not be read", {
          work_item_id,
          flow_job_id: workItem.flow_job_id,
          ...failure,
        }),
    ),
  );
  if (refusal !== null) throw new Error(refusal);

  const leased = usesImplementLease(plan);
  const note = `retry_work_item: restarted from ${workItem.status}`;
  const moved = leased
    ? await updateStatusIfCurrentClearingFlowJobId(
        work_item_id,
        workItem.status,
        plan.toStatus,
        note,
      )
    : await updateStatusIfCurrent(
        work_item_id,
        workItem.status,
        plan.toStatus,
        note,
      );
  if (!moved) {
    throw new Error(
      `retry_work_item: work item ${work_item_id} is no longer "${workItem.status}"; not restarted`,
    );
  }

  let flowJobId: string;
  try {
    flowJobId = parseFlowJobId(
      await wmill.runFlowAsync(plan.flowPath, plan.args),
      "runFlowAsync",
    );
  } catch (err) {
    // 起動できなかった作業項目を、動くジョブの無いままreconcileの猶予まで残さない。
    // flow_job_idは実装フローなら比較交換で空にした値、それ以外は読み取った値のまま。
    throw await launchFailureError(
      plan.flowPath,
      maskSecrets(err instanceof Error ? err.message : String(err)),
      (reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          plan.toStatus,
          "needs_human",
          leased ? null : workItem.flow_job_id,
          reason,
        ),
      (message, fields) =>
        logger("retry_work_item").warn(message, { work_item_id, ...fields }),
    );
  }

  let recorded = true;
  if (leased) {
    recorded = await setFlowJobIdIfUnset(work_item_id, flowJobId);
    if (!recorded) {
      logger("retry_work_item").warn(
        "flow job id not recorded; another run holds the lease",
        { work_item_id, started_job_id: flowJobId },
      );
    }
  } else {
    await setFlowJobId(work_item_id, flowJobId);
  }
  return retryResult(plan.toStatus, flowJobId, recorded);
}
