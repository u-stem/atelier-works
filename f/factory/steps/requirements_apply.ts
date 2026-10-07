// 判断済みの承認依頼(`factory.approval_requests`の`kind = "requirements"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動する、フローから独立したジョブである。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getApprovalRequest,
  getWorkItem,
  recordFailure,
  setFlowJobId,
  setFlowJobIdIfUnset,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { commentIssue, type GhClient, getViewer } from "../lib/github.ts";
import {
  parseFlowJobId,
  startImplement,
} from "../lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "../lib/implement_loop.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { type FactoryConfig, isNumber, type WorkItem } from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

export type RequirementsApplyOutcome =
  | "approved"
  | "retrying"
  | "needs_human"
  | "no_op";

export type RequirementsApplyResult = {
  readonly outcome: RequirementsApplyOutcome;
  /** 承認したときだけ入る。implementフローを起動したかどうか。 */
  readonly implement_started?: boolean;
};

/**
 * 処理を進めてよいかを返す。作業項目がまだ`awaiting_approval`のときだけ真。
 * 副作用は無い。
 */
export function shouldProceed(status: WorkItem["status"]): boolean {
  return status === "awaiting_approval";
}

/**
 * 承認を伝える1行のIssueコメントを組み立てる。副作用は無い。
 * GitHubには成果物だけを載せる方針のため、下書きの本文は投稿せず、
 * Consoleへのリンクを1つだけ載せる。
 * URLに加えて`work_item_id`も書くのは、Consoleがディープリンクの
 * フラグメントを読めないとき(opaque originのraw app。
 * `lib/approval_support.ts`の`buildConsoleUrl`を参照)の手動の代替手段にするため。
 * 人はこの値を要件定義タブの`work_item_id`フィルタに貼り付けられる。
 */
export function buildApprovedComment(
  consoleUrl: string,
  workItemId: number,
): string {
  return `要件定義が承認されました。Console で内容を確認できます: ${consoleUrl}(work_item_id: ${String(workItemId)})`;
}

export type RejectedOutcome = "retry" | "needs_human";

/**
 * 却下された下書きについて、要件定義を生成し直すか(retry)、
 * 諦めて`needs_human`にするかを返す。副作用は無い。
 * `attempt`は却下されたばかりの試行回数。
 */
export function decideRejectedOutcome(
  attempt: number,
  maxAttempts: number,
): RejectedOutcome {
  return attempt < maxAttempts ? "retry" : "needs_human";
}

/**
 * 承認依頼の`payload.attempt`を型ガードで読み、無いか数値でなければ
 * `fallback`を返す。副作用は無い。
 * "requirements"の依頼は`pipeline_request_approval.ts`が数値の`attempt`で書くが、
 * 外部のDBの値の形は確かめずに信用しない。
 */
export function readRequestAttempt(
  payload: Record<string, unknown>,
  fallback: number,
): number {
  return isNumber(payload.attempt) ? payload.attempt : fallback;
}

/** 要件定義用のworktreeを消す。失敗しても警告を記録するだけで投げない。 */
async function removeReqWorktree(workItem: WorkItem): Promise<void> {
  if (workItem.issue_number === null) return;
  const repoDir = `/workspaces/${workItem.owner}/${workItem.repo}/main`;
  const worktreeDir = `/workspaces/${workItem.owner}/${workItem.repo}/req-${workItem.issue_number}`;
  try {
    await removeWorktree({
      run: runCommand,
      repoDir,
      dir: worktreeDir,
      force: true,
    });
  } catch (err) {
    logger("requirements_apply").warn(
      "failed to remove requirements worktree",
      {
        worktreeDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      },
    );
  }
}

async function notifySafe(
  webhookUrl: string,
  event: Parameters<typeof notify>[1],
): Promise<void> {
  if (webhookUrl.length === 0) return;
  await notify(webhookUrl, event);
}

/**
 * 承認依頼を読み、承認・却下に応じて作業項目を遷移させる。
 *
 * どの分岐でも先に作業項目の現在の状態を読み直し、`awaiting_approval`以外なら
 * 何もしない。並行する`poll_issues`の照合や、このスクリプトの再起動が
 * 既に作業項目を進めていることがあるため。
 * Issueのラベルはどの遷移でも付け外ししない。
 * トリガーの`factory`ラベルは着手時に消費済みで、状態は`work_items.status`だけが持つ。
 * 人がIssueにラベルを付け直すと、新しいサイクルが始まる。
 * 要件定義用のworktreeは、どの分岐でも最後に消す。
 * 承認したときは、`implement_enabled`が有効な場合に限りimplementフローを起動する。
 *
 * どの分岐でも、CAS(`updateStatusIfCurrent`)はGitHubへの副作用
 * (承認コメント)より先に行う。
 * この分岐を再び動かすものは他に無いため、GitHubの呼び出しが失敗して
 * 作業項目が`awaiting_approval`のまま残ると、判断が事実上失われる。
 * `commentIssue`はマーカーで冪等で、通知は繰り返しても安全なので、
 * 再起動(`approval_decide.ts`の`redispatch`など)でやり直してよい。
 *
 * 承認依頼・作業項目・Issue番号が無いとき、依頼のkindが違うときは例外を投げる。
 */
async function run(
  approval_request_id: number,
  log: Logger,
): Promise<RequirementsApplyResult> {
  const config: FactoryConfig = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `requirements_apply: no approval request with id ${approval_request_id}`,
    );
  }
  if (request.kind !== "requirements") {
    throw new Error(
      `requirements_apply: approval request ${approval_request_id} has kind "${request.kind}", expected "requirements"`,
    );
  }

  const workItem = await getWorkItem(request.work_item_id);
  if (workItem === null) {
    throw new Error(
      `requirements_apply: no work item with id ${request.work_item_id}`,
    );
  }
  if (!shouldProceed(workItem.status)) {
    log.info("work item is not awaiting_approval, no-op", {
      work_item_id: workItem.id,
      status: workItem.status,
    });
    return { outcome: "no_op" };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `requirements_apply: work item ${workItem.id} has no issue_number`,
    );
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    // 防御的な検査。`approval_decide.ts`は"approved"か"rejected"を
    // 記録した直後にしかここを起動しない。
    // "expired"(またはまだ"pending")の依頼が来たなら、
    // `poll_issues.ts`の期限切れ処理と競合している。
    // 期限切れへの遷移はその処理が受け持つため、ここでは重ねて遷移させずに何もしない。
    log.info("approval request is not decided, no-op", {
      approval_request_id,
      status: request.status,
    });
    return { outcome: "no_op" };
  }

  const viewer = await getViewer(client);
  const attempt = readRequestAttempt(request.payload, workItem.attempt);

  if (request.status === "approved") {
    const updated = await updateStatusIfCurrent(
      workItem.id,
      "awaiting_approval",
      "approved",
      null,
    );
    if (!updated) {
      log.info("work item moved on before approval could be finalized", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    const consoleUrl = buildConsoleUrl(config.windmill_public_url, {
      work_item_id: workItem.id,
    });
    await commentIssue(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      `issue-approved-${String(attempt)}`,
      workItem.id,
      buildApprovedComment(consoleUrl, workItem.id),
      viewer.login,
    );
    await notifySafe(webhookUrl, {
      kind: "requirements_approved",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      issue_number: workItem.issue_number,
      issue_url: workItem.issue_url ?? "",
      title: workItem.title ?? "",
      console_url: consoleUrl,
    });
    await removeReqWorktree(workItem);
    if (!config.implement_enabled)
      return { outcome: "approved", implement_started: false };
    const issueNumber = workItem.issue_number;
    const launched = await startImplement({
      casToImplementing: () =>
        updateStatusIfCurrentClearingFlowJobId(
          workItem.id,
          "approved",
          "implementing",
          null,
        ),
      launchFlow: () =>
        wmill.runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id: workItem.id }),
      recordFlowJobId: (jobId) => setFlowJobIdIfUnset(workItem.id, jobId),
      moveToNeedsHuman: (reason) =>
        updateStatusIfLeaseHolder(
          workItem.id,
          "implementing",
          "needs_human",
          null,
          reason,
        ),
      recordFailure: async (reason, step) => {
        await recordFailure({
          work_item_id: workItem.id,
          flow_path: IMPLEMENT_FLOW_PATH,
          job_id: process.env.WM_JOB_ID ?? "unknown",
          step,
          error: reason,
        });
      },
      addNotice: async (reason) => {
        await addNotice({
          kind: "implement_launch_failed",
          message: `${workItem.owner}/${workItem.repo}#${String(issueNumber)} (work item ${String(workItem.id)}): ${describeReason(reason)}`,
        });
      },
      notifyNeedsHuman: (reason) =>
        notifySafe(webhookUrl, {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner: workItem.owner,
          repo: workItem.repo,
          url: workItem.issue_url ?? "",
          reason: describeReason(reason),
          target: { kind: "issue", number: issueNumber },
          next_action: nextActionFor(reason),
        }),
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
    return {
      outcome: "approved",
      implement_started:
        launched === "started" || launched === "started_without_job_id",
    };
  }

  // ここからは却下のとき。
  const rejectedOutcome = decideRejectedOutcome(attempt, config.max_attempts);
  if (rejectedOutcome === "retry") {
    const updated = await updateStatusIfCurrent(
      workItem.id,
      "awaiting_approval",
      "requirements_generating",
      request.reason,
    );
    if (!updated) {
      log.info("work item moved on before retry could be started", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    // `runFlowAsync`は、他のDB・GitHubへの副作用(ここではworktreeの片付けだけ)の後に呼ぶ。
    // 次の試行のフローは並行して動き、すぐに自身の準備ステップで`work_items`を読み直すため、
    // 起動した時点でここに実行中の処理が残っていてはならない。
    // `setFlowJobId`は`runFlowAsync`が返すidを記録するので、その直後に置くしかない。
    // 応答がジョブIDでなければ例外にし、起動の失敗と同じく`main`が記録して通知する。
    await removeReqWorktree(workItem);
    const flowJobId = parseFlowJobId(
      await wmill.runFlowAsync("f/factory/pipeline", {
        work_item_id: workItem.id,
        attempt: attempt + 1,
        feedback: request.reason ?? "",
      }),
      "runFlowAsync",
    );
    await setFlowJobId(workItem.id, flowJobId);
    return { outcome: "retrying" };
  }

  const updated = await updateStatusIfCurrent(
    workItem.id,
    "awaiting_approval",
    "needs_human",
    request.reason,
  );
  if (!updated) {
    log.info("work item moved on before needs_human could be recorded", {
      work_item_id: workItem.id,
    });
    return { outcome: "no_op" };
  }
  await notifySafe(webhookUrl, {
    kind: "needs_human",
    instance_name: config.instance_name,
    owner: workItem.owner,
    repo: workItem.repo,
    url: workItem.issue_url ?? "",
    reason: describeReason(`rejected ${String(config.max_attempts)} times`),
    target: { kind: "issue", number: workItem.issue_number },
    next_action: nextActionFor(`rejected ${String(config.max_attempts)} times`),
  });
  await removeReqWorktree(workItem);
  return { outcome: "needs_human" };
}

/**
 * `approval_request_id`の承認依頼を処理し、その結果を返す。
 * このスクリプトはフローのステップではなく単独で動くため、
 * フローの`on_error_flow`に頼れない。
 * そのため例外はここで捕まえ、`factory.job_failures`に記録して
 * Discordへ通知してから投げ直す(`on_error_schedule.ts`と同じ自己完結の処理)。
 */
export async function main(
  approval_request_id: number,
): Promise<RequirementsApplyResult> {
  const log = logger("requirements_apply");
  try {
    return await run(approval_request_id, log);
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("requirements_apply failed", { error: message });
    try {
      await recordFailure({
        work_item_id: null,
        flow_path: "f/factory/steps/requirements_apply",
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step: null,
        error: message,
      });
    } catch (recordErr) {
      log.error("failed to record failure", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    try {
      const config = await loadConfig(() =>
        wmill.getResource("f/factory/factory_config"),
      );
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        await notify(webhookUrl, {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/steps/requirements_apply",
          job_id: process.env.WM_JOB_ID ?? "unknown",
          error: message,
        });
      }
    } catch (notifyErr) {
      log.error("failed to send discord notification", {
        error: maskSecrets(
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        ),
      });
    }
    throw err;
  }
}
