// 書き込みが成功したときに画面へ出す知らせ(トースト)の文。
// 失敗の文は`describeApiError`が作るので、ここでは作らない。

import type {
  ApprovalDecideResult,
  AuditKickoffResult,
  AuditSkipReason,
  NoticeResolveResult,
  RetryWorkItemResult,
} from "../api/guards/writeResults.ts";
import { workItemStatusLabel } from "./labels.ts";

/**
 * 画面に出す知らせ。
 * `success`は操作が済んだこと、`info`は何も変えなかった正常な結果、
 * `warning`は済んだが確かめてほしいことを表す。
 */
type WriteNotice = {
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
