// f/factory/designフローの承認依頼ステップ。
// 設計書の下書きへの承認依頼(種類`design`)を記録して作業項目を設計の承認待ちへ移し、通知して、人の判断を待たずに返る。
// 設計フローのリース(`flow_job_id`がこのフローのジョブID)を持たなければ、何も書かずに終わる。
// 依頼を記録してから作業項目を移すまでの間に判断が記録されていたときは、移行の後に依頼を読み直し、
// 設計の承認の反映を起動する。承認待ちの通知は、判断済みの依頼には送らない。
// 人の判断を反映する処理と、放置された依頼の期限切れは、このステップの範囲外である。

import * as wmill from "windmill-client@1.817.0";
import {
  buildApprovalConsoleUrl,
  computeExpiresAt,
  handlerPathFor,
} from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  expireApprovalRequestIfPending,
  getApprovalRequest,
  getWorkItem,
  insertApprovalRequest,
  latestDesignDraft,
  latestRequirementsApproval,
  type NewApprovalRequest,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { DESIGN_APPROVAL_TIMED_OUT_REASON } from "../lib/design_template.ts";
import {
  type NotifyBestEffortResult,
  type NotifyEvent,
  notifyBestEffort,
} from "../lib/discord.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import {
  holdsPipelineLease,
  PIPELINE_LEASE_LOST_REASON,
} from "../lib/pipeline_lease.ts";
import type {
  ApprovalRequest,
  DesignDraft,
  FactoryConfig,
  WorkItem,
} from "../lib/types.ts";
import { designNeedsHumanFields } from "./pr_workflow_support.ts";

/** 承認依頼を記録した後に作業項目を動かせなかったときの理由。 */
export const DESIGN_APPROVAL_WITHDRAWN_REASON =
  "work item moved on before design approval could be requested; the approval request was expired";

/** 作業項目を動かせず、期限切れにする前に人が依頼を判断していたときの理由。 */
export const DESIGN_APPROVAL_ALREADY_DECIDED_REASON =
  "work item moved on before design approval could be requested, but the approval request had already been decided";

export type DesignRequestApprovalResult =
  | { readonly ok: true; readonly approval_request_id: number }
  | { readonly ok: false; readonly reason: string };

export type DesignRequestApprovalDeps = {
  /** このフローのルートジョブID。リースの値。 */
  readonly leaseJobId: string;
  readonly now: () => Date;
  readonly config: Pick<FactoryConfig, "instance_name" | "windmill_public_url">;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly latestDesignDraft: (id: number) => Promise<DesignDraft | null>;
  /** 作業項目の最新の要件定義の承認(`latestRequirementsApproval`)。 */
  readonly latestRequirementsApproval: (id: number) => Promise<{
    readonly draft_id: number;
    readonly status: string;
    readonly attempt: number;
  } | null>;
  readonly insertApprovalRequest: (
    input: NewApprovalRequest,
  ) => Promise<number>;
  /** リースを条件にした比較交換で、`designing`から`awaiting_design_approval`へ移す。 */
  readonly moveToAwaitingDesignApproval: () => Promise<boolean>;
  /** 記録した承認依頼を期限切れにする。期限切れにする前に人が判断していたら`false`を返す。 */
  readonly withdrawRequest: (id: number) => Promise<boolean>;
  /** 移行の後に承認依頼を読み直す。 */
  readonly getApprovalRequest: (id: number) => Promise<ApprovalRequest | null>;
  /** 判断済みの依頼の反映(`handlerPathFor("design")`の処理先)を起動する。 */
  readonly runHandler: (approvalRequestId: number) => Promise<string>;
  /** 期限切れの依頼のとき、リースを条件にした比較交換で、`awaiting_design_approval`から`expired`へ移す。 */
  readonly moveToExpired: () => Promise<boolean>;
  /** `needs_human`を通知する(届かなくても失敗しない)。 */
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  /** 通知が届かなかったことを、Consoleのnoticeに残す。 */
  readonly recordNotifyFailure: (message: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 承認依頼の通知が届かなかったときに残すnoticeの本文を作る。副作用は無い。
 * 承認依頼そのものは記録済みなので、Consoleから判断できることを伝える。
 */
function notifyFailedMessage(
  item: WorkItem,
  issueNumber: number,
  reason: string,
): string {
  return `${item.owner}/${item.repo}#${String(issueNumber)} (work item ${String(item.id)}): 設計の承認依頼のDiscord通知を送れませんでした(${reason})。承認依頼はConsoleの要対応で待っています。`;
}

/**
 * 移行の後に依頼の状態を読み直す。読み直しが例外を投げた、または依頼が見つからないときは`pending`を返す。
 */
async function readRequestStatus(
  deps: DesignRequestApprovalDeps,
  approvalRequestId: number,
): Promise<ApprovalRequest["status"]> {
  try {
    const request = await deps.getApprovalRequest(approvalRequestId);
    return request === null ? "pending" : request.status;
  } catch (err) {
    deps.log("failed to read the approval request after the move", {
      approval_request_id: approvalRequestId,
      error: maskSecrets(String(err)),
    });
    return "pending";
  }
}

/**
 * `design_attempt`回目の設計書の下書きに対する承認依頼(種類`design`)を記録し、作業項目を`awaiting_design_approval`へ進め、
 * Discordへ`design_approval_requested`を通知する。
 *
 * 設計フローのリースを持っていなければ、依頼を記録せずに`ok: false`を返す(例外は投げない)。
 * 最新の下書きが現在の設計の試行のものでなければ、またはその下書きが最新の承認済みの要件定義から作ったものでなければ、
 * 承認依頼を作る前に例外を投げる。古い下書きを人が承認できないようにするためである。
 * 記録の後に作業項目を動かせなかったとき(リースが移った、状態が先へ進んだ)は、記録した依頼を期限切れにし、
 * 通知せずに`ok: false`を返す。期限切れにする前に人が判断していたときも、通知せずに`ok: false`を返す。
 * 動かす処理が例外を投げたときも、依頼を期限切れにしてから同じ例外を投げ直す。
 * 通知が届かなくても失敗せず、Consoleにnoticeを残す。承認依頼は記録済みで、Consoleから判断できるため。
 *
 * 作業項目を動かせたら、依頼を読み直す。記録から移行までの間に、人が判断を記録していることがあり、
 * そのときは反映が作業項目の状態(`designing`)に阻まれて何もせず、判断が失われるためである。
 * - `approved`か`rejected`: 設計の承認の反映を起動し、承認待ちの通知は送らない(人はすでに判断している)。
 *   起動に失敗しても例外にしない。作業項目は決定済みで未反映の待ちになり、承認待ちの走査が起動し直す。
 *   起動した後は、状態や作業の場所を書く処理を呼ばない(反映と競合させないため)。
 * - `expired`: 作業項目を`expired`へ移して`needs_human`を通知し、承認待ちの通知は送らない。
 * - `pending`: 承認待ちの通知を送る。読み直しが例外を投げた、または依頼が見つからないときも、`pending`と同じに扱う。
 *   取りこぼした判断は、承認待ちの走査が拾う。
 */
export async function runDesignRequestApproval(
  deps: DesignRequestApprovalDeps,
  input: { readonly work_item_id: number; readonly design_attempt: number },
): Promise<DesignRequestApprovalResult> {
  const workItemId = input.work_item_id;
  const item = await deps.getWorkItem(workItemId);
  if (item === null) {
    throw new Error(
      `design_request_approval: no work item with id ${workItemId}`,
    );
  }
  const issueNumber = item.issue_number;
  if (issueNumber === null) {
    throw new Error(
      `design_request_approval: work item ${workItemId} has no issue_number`,
    );
  }

  if (
    item.status !== "designing" ||
    !holdsPipelineLease(item, deps.leaseJobId)
  ) {
    deps.log(PIPELINE_LEASE_LOST_REASON, {
      work_item_id: workItemId,
      status: item.status,
      flow_job_id: item.flow_job_id,
      lease_job_id: deps.leaseJobId,
    });
    return { ok: false, reason: PIPELINE_LEASE_LOST_REASON };
  }

  const draft = await deps.latestDesignDraft(workItemId);
  if (draft === null || draft.design_attempt !== input.design_attempt) {
    throw new Error(
      `design_request_approval: work item ${workItemId} has no design draft for design attempt ${String(input.design_attempt)}`,
    );
  }
  const approval = await deps.latestRequirementsApproval(workItemId);
  if (
    approval === null ||
    approval.status !== "approved" ||
    approval.draft_id !== draft.requirement_draft_id
  ) {
    throw new Error(
      `design_request_approval: the design draft ${draft.id} of work item ${workItemId} does not match the approved requirements`,
    );
  }

  const approvalRequestId = await deps.insertApprovalRequest({
    kind: "design",
    work_item_id: workItemId,
    subject_id: draft.id,
    payload: { attempt: item.attempt, design_attempt: input.design_attempt },
    expires_at: computeExpiresAt(deps.now()),
  });

  let moved: boolean;
  try {
    moved = await deps.moveToAwaitingDesignApproval();
  } catch (err) {
    // 動かせたか分からないまま依頼をpendingで残すと、古い下書きを人が承認できてしまう。
    // 取り下げに失敗しても、元のエラーを隠さずに投げ直す。
    try {
      await deps.withdrawRequest(approvalRequestId);
    } catch (withdrawErr) {
      deps.log("failed to expire the approval request after a failed move", {
        work_item_id: workItemId,
        approval_request_id: approvalRequestId,
        error: maskSecrets(String(withdrawErr)),
      });
    }
    throw err;
  }
  if (!moved) {
    // 依頼をpendingのまま残すと、古い下書きを人が承認できてしまう。
    if (await deps.withdrawRequest(approvalRequestId)) {
      deps.log("work item moved on before design approval could be requested", {
        work_item_id: workItemId,
        approval_request_id: approvalRequestId,
      });
      return { ok: false, reason: DESIGN_APPROVAL_WITHDRAWN_REASON };
    }
    // 判断の扱いは、設計の承認の反映に任せ、ここでは記録だけ残す。
    deps.log(DESIGN_APPROVAL_ALREADY_DECIDED_REASON, {
      work_item_id: workItemId,
      approval_request_id: approvalRequestId,
    });
    return { ok: false, reason: DESIGN_APPROVAL_ALREADY_DECIDED_REASON };
  }

  const requestStatus = await readRequestStatus(deps, approvalRequestId);
  if (requestStatus === "approved" || requestStatus === "rejected") {
    try {
      await deps.runHandler(approvalRequestId);
    } catch (err) {
      deps.log("failed to start the design approval handler", {
        work_item_id: workItemId,
        approval_request_id: approvalRequestId,
        error: maskSecrets(String(err)),
      });
    }
    return { ok: true, approval_request_id: approvalRequestId };
  }
  if (requestStatus === "expired") {
    if (await deps.moveToExpired()) {
      // 作業項目は`expired`へ移った。通知を送る処理が落ちても、ステップを失敗させない。
      try {
        await deps.notifyNeedsHuman(DESIGN_APPROVAL_TIMED_OUT_REASON);
      } catch (err) {
        deps.log("failed to notify the timed out design approval", {
          work_item_id: workItemId,
          error: maskSecrets(String(err)),
        });
      }
    }
    return { ok: false, reason: DESIGN_APPROVAL_TIMED_OUT_REASON };
  }

  const notifyResult = await deps.notify({
    kind: "design_approval_requested",
    instance_name: deps.config.instance_name,
    owner: item.owner,
    repo: item.repo,
    issue_number: issueNumber,
    issue_url: item.issue_url ?? "",
    title: item.title ?? "",
    inbox_url: buildApprovalConsoleUrl(
      deps.config.windmill_public_url,
      approvalRequestId,
    ),
  });
  if (notifyResult.status === "not_sent") {
    try {
      await deps.recordNotifyFailure(
        notifyFailedMessage(item, issueNumber, notifyResult.reason),
      );
    } catch (err) {
      deps.log("failed to record approval notify notice", {
        error: maskSecrets(String(err)),
      });
    }
  }

  deps.log("requested design approval", {
    work_item_id: workItemId,
    design_attempt: input.design_attempt,
    approval_request_id: approvalRequestId,
  });
  return { ok: true, approval_request_id: approvalRequestId };
}

/**
 * 設計の承認依頼ステップ。本番の依存を組み立てて`runDesignRequestApproval`を呼ぶ。
 * フローのルートジョブIDを得られないときは例外を投げる。
 */
export async function main(
  work_item_id: number,
  design_attempt: number,
): Promise<DesignRequestApprovalResult> {
  const log = logger("design_request_approval");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const leaseJobId = rootFlowJobId(process.env);

  return runDesignRequestApproval(
    {
      leaseJobId,
      now: () => new Date(),
      config,
      getWorkItem: (id) => getWorkItem(id),
      latestDesignDraft: (id) => latestDesignDraft(id),
      latestRequirementsApproval: (id) => latestRequirementsApproval(id),
      insertApprovalRequest: (request) => insertApprovalRequest(request),
      moveToAwaitingDesignApproval: () =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "designing",
          "awaiting_design_approval",
          leaseJobId,
          null,
        ),
      withdrawRequest: (id) => expireApprovalRequestIfPending(id),
      getApprovalRequest: (id) => getApprovalRequest(id),
      runHandler: (approvalRequestId) =>
        wmill.runScriptByPathAsync(handlerPathFor("design"), {
          approval_request_id: approvalRequestId,
        }),
      moveToExpired: () =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "awaiting_design_approval",
          "expired",
          leaseJobId,
          DESIGN_APPROVAL_TIMED_OUT_REASON,
        ),
      notifyNeedsHuman: async (reason) => {
        const item = await getWorkItem(work_item_id);
        if (item === null) return;
        await notifyBestEffort(
          await wmill.getVariable("f/factory/discord_webhook_url"),
          {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner: item.owner,
            repo: item.repo,
            url: item.issue_url ?? "",
            ...designNeedsHumanFields(reason),
            target: { kind: "issue", number: item.issue_number ?? 0 },
          },
          log,
        );
      },
      notify: async (event) =>
        notifyBestEffort(
          await wmill.getVariable("f/factory/discord_webhook_url"),
          event,
          log,
        ),
      recordNotifyFailure: async (message) => {
        await addNoticeUnlessUnresolved({
          kind: "approval_notify_failed",
          message,
        });
      },
      log: (message, fields) => log.info(message, fields),
    },
    { work_item_id, design_attempt },
  );
}
