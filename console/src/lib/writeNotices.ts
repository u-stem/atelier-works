// 書き込みが成功したときに画面へ出す知らせ(トースト)の文。
// 失敗の文は`describeWriteFailure`が作るので、ここでは作らない。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type {
  ApprovalDecideResult,
  AuditKickoffResult,
  AuditSkipReason,
  FreezeReleaseResult,
  HoldReleaseResult,
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
    return {
      tone: "warning",
      message:
        "別の実行が先に作業項目を押さえていたため、起動したジョブは記録されていません。一覧を読み直して状態を確かめてください。",
    };
  }
  return {
    tone: "success",
    message: `再実行を始めました(状態: ${workItemStatusLabel(result.status)})。`,
  };
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
    return {
      tone: "warning",
      message: `保留を解除しました。ただし、解除の前に有効だったかは確認できませんでした。${result.audit === "failed" ? AUDIT_FAILED_NOTE : ""}`,
    };
  }
  if (!result.was_active) {
    return { tone: "success", message: "期限切れの保留を片付けました。" };
  }
  if (result.audit === "failed") {
    return {
      tone: "warning",
      message: `保留を解除しました。${AUDIT_FAILED_NOTE}`,
    };
  }
  return { tone: "success", message: "保留を解除しました。" };
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
      return {
        tone: "warning",
        message:
          "解除を確認できませんでした。一覧を取り直して確かめてください。",
      };
    case "released": {
      const subject = result.scope === "deploy" ? "deployの保留" : "凍結";
      if (result.audit === "failed") {
        return {
          tone: "warning",
          message: `${subject}を解除しました。${AUDIT_FAILED_NOTE}`,
        };
      }
      return { tone: "success", message: `${subject}を解除しました。` };
    }
  }
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
