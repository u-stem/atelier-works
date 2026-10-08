// f/factory/pipelineの承認依頼ステップ。
// 要件定義の下書きへの承認依頼を記録して通知し、人の判断を待たずに返る。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl, computeExpiresAt } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getWorkItem,
  insertApprovalRequest,
  latestDraft,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import {
  type NotifyBestEffortResult,
  notifyBestEffort,
} from "../lib/discord.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";

export type PipelineRequestApprovalResult = {
  readonly ok: true;
  readonly approval_request_id: number;
};

/**
 * 承認依頼の通知が届かなかったときに残すnoticeの本文を作る。副作用は無い。
 * 承認依頼そのものは記録済みなので、Consoleから判断できることを伝える。
 */
export function buildApprovalNotifyFailedMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly issue_number: number;
    readonly work_item_id: number;
  },
  reason: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.issue_number)} (work item ${String(target.work_item_id)}): 承認依頼のDiscord通知を送れませんでした(${reason})。承認依頼はConsoleのInboxで待っています。`;
}

/**
 * 承認依頼の通知が届かなかったとき(`not_sent`)に、`recordNotice`でConsoleのnoticeを残す。
 * 通知が無いと、人は承認依頼が来たことに気づけないため。
 * webhookを設定していないとき(`no_webhook`)は、Consoleを見る運用なので残さない。
 * `recordNotice`が失敗してもwarnを残すだけで、例外は投げない。
 */
export async function reportApprovalNotifyFailure(
  result: NotifyBestEffortResult,
  recordNotice: (reason: string) => Promise<void>,
  log: Logger,
): Promise<void> {
  if (result.status !== "not_sent") return;
  try {
    await recordNotice(result.reason);
  } catch (err) {
    log.warn("failed to record approval notify notice", {
      error: maskSecrets(String(err)),
    });
  }
}

/**
 * `attempt`回目の下書きに対する承認依頼(kind "requirements")を
 * `factory.approval_requests`に記録し、作業項目を`awaiting_approval`に進め、
 * Discordへapproval_requestedを通知する。
 * 作業項目が既に`requirements_generating`から動いていたら、
 * 依頼の記録だけで通知せずに返る。
 * 通知が届かなくても失敗せず、Consoleに`approval_notify_failed`のnoticeを残す。
 * 承認依頼は記録済みで、Consoleから判断できるため。
 * 作業項目・Issue番号・該当attemptの下書きが無ければ例外を投げる。
 *
 * 人の判断は`f/factory/approval_decide.ts`が別途受け付け、
 * `f/factory/steps/requirements_apply.ts`へ渡す。
 * `expires_at`を過ぎても未決の依頼は、`poll_issues.ts`の定期処理が期限切れにする。
 */
export async function main(
  work_item_id: number,
  attempt: number,
): Promise<PipelineRequestApprovalResult> {
  const log = logger("pipeline_request_approval");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(
      `pipeline_request_approval: no work item with id ${work_item_id}`,
    );
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_request_approval: work item ${work_item_id} has no issue_number`,
    );
  }

  const draft = await latestDraft(work_item_id);
  if (draft === null || draft.attempt !== attempt) {
    throw new Error(
      `pipeline_request_approval: work item ${work_item_id} has no requirement draft for attempt ${String(attempt)}`,
    );
  }

  const approvalRequestId = await insertApprovalRequest({
    kind: "requirements",
    work_item_id,
    subject_id: draft.id,
    payload: { attempt },
    expires_at: computeExpiresAt(new Date()),
  });

  const updated = await updateStatusIfCurrent(
    work_item_id,
    "requirements_generating",
    "awaiting_approval",
    null,
  );
  if (!updated) {
    log.info("work item moved on before approval could be requested", {
      work_item_id,
    });
    return { ok: true, approval_request_id: approvalRequestId };
  }

  const inboxUrl = buildConsoleUrl(config.windmill_public_url, {
    work_item_id,
  });

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const issueNumber = workItem.issue_number;
  const notifyResult = await notifyBestEffort(
    webhookUrl,
    {
      kind: "approval_requested",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      issue_number: issueNumber,
      issue_url: workItem.issue_url ?? "",
      title: workItem.title ?? "",
      inbox_url: inboxUrl,
    },
    log,
  );
  await reportApprovalNotifyFailure(
    notifyResult,
    async (reason) => {
      await addNotice({
        kind: "approval_notify_failed",
        message: buildApprovalNotifyFailedMessage(
          {
            owner: workItem.owner,
            repo: workItem.repo,
            issue_number: issueNumber,
            work_item_id,
          },
          reason,
        ),
      });
    },
    log,
  );

  log.info("requested approval", {
    work_item_id,
    attempt,
    approval_request_id: approvalRequestId,
  });

  return { ok: true, approval_request_id: approvalRequestId };
}
