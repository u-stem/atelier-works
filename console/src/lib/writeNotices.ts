// 書き込みが成功したときに画面へ出す知らせ(トースト)の文。
// 失敗の文は`describeWriteFailure`が作るので、ここでは作らない。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type {
  ActionAudit,
  ApprovalDecideResult,
  AuditKickoffResult,
  AuditSkipReason,
  FreezeReleaseResult,
  HoldReleaseResult,
  JobCancelRefusalReason,
  JobCancelResult,
  JobCancelWorkItem,
  NoticeResolveResult,
  RetryWorkItemResult,
} from "../api/guards/writeResults.ts";
import { workItemStatusLabel } from "./labels.ts";

/**
 * 画面に出す知らせ。
 * `success`は操作が済んだこと、`info`は何も変えなかった正常な結果、
 * `warning`は済んだが確かめてほしいことを表す。
 */
export type WriteNotice = {
  readonly tone: "success" | "info" | "warning";
  readonly message: string;
};

/**
 * 書き込みの後に一覧を読み直せなかったときの知らせ。
 * 一覧は古いままで、済んだ操作を押し直せてしまうので、更新されるまでその対象は止めておく。
 */
export const STALE_LIST_NOTICE: WriteNotice = {
  tone: "warning",
  message:
    "一覧を読み直せませんでした。一覧が更新されるまで、この対象は操作できません。",
};

const ACTION_AUDIT_FAILED_NOTE =
  "ただし、操作の記録を残せませんでした。誰が操作したかは、ジョブのログで確かめてください。";

/**
 * 操作の記録(`factory.console_actions`)を書けなかったときに、注意を添えて警告にする。
 * 操作は済んでいるので、成功の文は消さない。解除の通知の記録(`audit`)とは別である。
 */
function noteActionAudit(
  notice: WriteNotice,
  audit: ActionAudit | undefined,
): WriteNotice {
  if (audit !== "failed") {
    return notice;
  }
  return {
    tone: "warning",
    message: `${notice.message}${ACTION_AUDIT_FAILED_NOTE}`,
  };
}

export function describeApprovalResult(
  result: ApprovalDecideResult,
): WriteNotice {
  return {
    tone: "success",
    message: result.status === "approved" ? "承認しました。" : "却下しました。",
  };
}

/**
 * 再実行の結果。`ok: false`でもフローは起動している。
 * 別の実行が先に作業項目のリースを取っていて、起動したジョブを記録しなかっただけである。
 */
export function describeRetryResult(result: RetryWorkItemResult): WriteNotice {
  if (!result.ok) {
    return noteActionAudit(
      {
        tone: "warning",
        message:
          "別の実行が先に作業項目を押さえていたため、起動したジョブは記録されていません。一覧を読み直して状態を確かめてください。",
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    {
      tone: "success",
      message: `再実行を始めました(状態: ${workItemStatusLabel(result.status)})。`,
    },
    result.action_audit,
  );
}

const AUDIT_SKIP_MESSAGES: Readonly<Record<AuditSkipReason, string>> = {
  audit_in_progress: "別の監査が進行中のため、起動しませんでした。",
  empty_period: "前回の監査以降の対象期間がまだないため、起動しませんでした。",
  no_new_records: "監査の対象になる新しい記録が無いため、起動しませんでした。",
  daily_budget_exceeded:
    "今日の予算の上限に達しているため、起動しませんでした。",
  concurrent_kickoff: "同時に起動した監査があったため、起動しませんでした。",
};

/** 監査の起動の結果。見送りは失敗ではなく、何も変えなかった正常な結果として伝える。 */
export function describeAuditResult(result: AuditKickoffResult): WriteNotice {
  if (result.skipped) {
    return { tone: "info", message: AUDIT_SKIP_MESSAGES[result.reason] };
  }
  return {
    tone: "success",
    message: `監査を始めました(対象期間: ${result.period_label})。`,
  };
}

/** 通知の解決の結果。解決済みだった通知も、成功として扱う。 */
export function describeNoticeResult(result: NoticeResolveResult): WriteNotice {
  return {
    tone: "success",
    message:
      result.status === "resolved"
        ? "解決済みにしました。"
        : "すでに解決済みです。",
  };
}

/** 解除の結果を知らせるトーストの文。書き込みの失敗は`error`にする。 */
export type ReleaseNotice = {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly message: string;
};

const AUDIT_FAILED_NOTE =
  "ただし、解除の記録(通知)を残せませんでした。誰が解除したかは、ジョブの記録で確かめてください。";

/**
 * 保留の解除の結果。解除済みの保留は、何も変えなかった正常な結果として伝える。
 * 期限切れの行を片付けただけのときは、通知を残さないので、記録の失敗の注意も付けない。
 */
export function describeHoldReleaseResult(
  result: HoldReleaseResult,
): WriteNotice {
  if (result.status === "already_released") {
    return { tone: "info", message: "すでに解除されています。" };
  }
  if (result.active_unknown === true) {
    return noteActionAudit(
      {
        tone: "warning",
        message: `保留を解除しました。ただし、解除の前に有効だったかは確認できませんでした。${result.audit === "failed" ? AUDIT_FAILED_NOTE : ""}`,
      },
      result.action_audit,
    );
  }
  if (!result.was_active) {
    return noteActionAudit(
      { tone: "success", message: "期限切れの保留を片付けました。" },
      result.action_audit,
    );
  }
  if (result.audit === "failed") {
    return noteActionAudit(
      {
        tone: "warning",
        message: `保留を解除しました。${AUDIT_FAILED_NOTE}`,
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    { tone: "success", message: "保留を解除しました。" },
    result.action_audit,
  );
}

/**
 * 凍結かdeployの保留の解除の結果。
 * `unconfirmed`は、解除が効いたか分からないので警告にし、一覧で確かめさせる。
 */
export function describeFreezeReleaseResult(
  result: FreezeReleaseResult,
): WriteNotice {
  switch (result.status) {
    case "already_ended":
      return {
        tone: "info",
        message: "すでに終わっています(解除済みか期限切れです)。",
      };
    case "unconfirmed":
      return noteActionAudit(
        {
          tone: "warning",
          message:
            "解除を確認できませんでした。一覧を取り直して確かめてください。",
        },
        result.action_audit,
      );
    case "released": {
      const subject = result.scope === "deploy" ? "deployの保留" : "凍結";
      if (result.audit === "failed") {
        return noteActionAudit(
          {
            tone: "warning",
            message: `${subject}を解除しました。${AUDIT_FAILED_NOTE}`,
          },
          result.action_audit,
        );
      }
      return noteActionAudit(
        { tone: "success", message: `${subject}を解除しました。` },
        result.action_audit,
      );
    }
  }
}

const JOB_CANCEL_REFUSALS: Readonly<Record<JobCancelRefusalReason, string>> = {
  flow_not_allowed: "このフローのジョブは、中止できない対象です。",
  not_a_root_flow:
    "フローの子のステップや、scriptのジョブは、中止できない対象です。",
  already_finished: "すでに終わっています。",
  already_canceling: "すでに中止済みです。止まるまで少しかかります。",
  scheduled_for_later: "予定の時刻が先のジョブは、中止できません。",
  actor_unknown: "操作者を確認できないため、中止しませんでした。",
  audit_unavailable: "操作の記録を残せないため、中止しませんでした。",
};

/** 人の判断を待つ作業項目の状態。照合は、この状態の作業項目を失敗にしない。 */
const WAITING_FOR_PERSON_STATUSES: readonly string[] = [
  "awaiting_approval",
  "awaiting_design_approval",
];

/** 中止の後に読み直した作業項目について伝える文。状態で、照合が失敗にするかが分かれる。 */
function describeCanceledWorkItem(workItem: JobCancelWorkItem | null): string {
  if (workItem === null) {
    return "作業項目の状態は読めませんでした。";
  }
  const head = `作業項目 #${String(workItem.id)} の状態: ${workItemStatusLabel(workItem.status)}。`;
  if (WAITING_FOR_PERSON_STATUSES.includes(workItem.status)) {
    return `${head}失敗にはならず、承認待ちのまま残ります。承認依頼の通知は届かないことがあります。`;
  }
  return workItem.lease_held
    ? `${head}リースがこのジョブを指したままなので、次の照合で失敗になります。`
    : head;
}

/**
 * ジョブの中止の結果。断りは失敗ではなく、何も変えなかった結果として伝える。
 * 中止の依頼は済んでいても、ジョブがまだ実行中か待ちに見えるときは、止まったとは言わず、状態を更新するよう伝える。
 * 中止の後に読み直した作業項目の状態を添える。承認待ちの作業項目は照合が失敗にしないので、失敗になるとは言わない。
 */
export function describeJobCancelResult(result: JobCancelResult): WriteNotice {
  if (!result.found) {
    return { tone: "info", message: "ジョブが見つかりません。" };
  }
  if (result.refused) {
    return { tone: "info", message: JOB_CANCEL_REFUSALS[result.reason] };
  }
  const workItem = describeCanceledWorkItem(result.work_item);
  const notStopped =
    result.job_state === "running" || result.job_state === "queued";
  const notice: WriteNotice = notStopped
    ? {
        tone: "warning",
        message: `中止を依頼しました。ジョブはまだ止まっていません。少し待って、状態を更新してください。${workItem}`,
      }
    : { tone: "success", message: `ジョブを中止しました。${workItem}` };
  return noteActionAudit(notice, result.action_audit);
}

/** 書き込みの結果を、トーストの文にする。失敗は、失敗の文をそのまま`error`にする。 */
export function releaseNotice<T>(
  outcome: WriteOutcome<T>,
  describe: (result: T) => WriteNotice,
): ReleaseNotice {
  if (outcome.kind === "failed") {
    return { tone: "error", message: outcome.message };
  }
  return describe(outcome.result);
}
