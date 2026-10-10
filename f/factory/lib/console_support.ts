// Factory Consoleが「要対応」を決めるための、通知の重要度と対象の定数。
// 重要度の対応表はbackendに置く。画面ごとに持つと、通知の種類を足したときに食い違うため。

import type { WorkItemStatus } from "./types.ts";

/** 通知の重要度。`info`は人の行動が要らず、`action`は人の対応が要る。 */
export type NoticeSeverity = "info" | "action";

/**
 * 通知の種類ごとの重要度。
 * `implement_needs_human`は作業項目が`needs_human`になり、要対応の一覧の失敗に行が出るので`info`とする。
 * `implement_launch_failed`は作業項目が承認済みや実装中のまま残り、要対応の一覧の失敗に出ない経路があるので`action`とする。
 * この対応表は、`docs/operations.md`の通知の表に載る種類をすべて含む。
 * 表に無い種類(将来足された種類)は、見落とさせないために`action`として扱う
 * (`noticeSeverity`)。
 */
export const NOTICE_SEVERITY: Readonly<Record<string, NoticeSeverity>> = {
  approval_notify_failed: "info",
  claim_race_lost: "info",
  supersede_failed: "info",
  cleanup_worktrees_skipped: "info",
  workspace_disk_usage: "info",
  fix_feedback_association_excluded: "info",
  labeler_denied: "info",
  unsandboxed_check_commands: "info",
  implement_needs_human: "info",
  approval_comment_failed: "action",
  implement_launch_failed: "action",
  fix_reply_post_failed: "action",
  pr_fix_reviewer_request_failed: "action",
  issue_proposal_record_failed: "action",
  claim_assignee_missing: "action",
  labeler_check_limit: "action",
  pr_trigger_label_left_removed: "action",
  deployed_sha_mismatch: "action",
  cleanup_db_failed: "action",
  cleanup_worktree_busy: "action",
  console_fetch_failed: "action",
  console_fetch_stale: "action",
  console_worker_missing: "action",
  console_worker_check_failed: "action",
  schedule_failing: "action",
  schedule_failing_check_failed: "action",
};

/** 重要度が`info`の種類。「要対応」の一覧には出さず、システム画面に7日だけ出す。 */
export const INFO_NOTICE_KINDS: readonly string[] = Object.entries(
  NOTICE_SEVERITY,
).flatMap(([kind, severity]) => (severity === "info" ? [kind] : []));

/**
 * Consoleから解決できない種類。
 * 設定や権限の問題を示す通知は、運用者が内容を確かめないまま消せてしまうと、
 * 安全策が外れていることが見えなくなるため。
 */
export const UNRESOLVABLE_NOTICE_KINDS: readonly string[] = [
  "unsandboxed_check_commands",
  "labeler_denied",
  "fix_feedback_association_excluded",
];

/**
 * 「要対応」の失敗に数える作業項目の状態。
 * `expired`(承認の期限切れ)は、Discordに人の対応を求める通知が届き、
 * `retry_work_item`で作り直せる状態なので含める。
 * `blocked`は含めない。安全策で修正の前に止めた状態で、失敗ではないため。
 */
export const ACTIONABLE_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "failed",
  "needs_human",
  "expired",
];

/** `info`の通知と、作業項目の無い失敗を、システム画面に出す日数。 */
export const INFO_NOTICE_WINDOW_DAYS = 7;

/**
 * `kind`の重要度を返す。表に無い種類は`action`を返す。
 * `Object.prototype`の名前(`constructor`など)は表にある種類として扱わない。
 */
export function noticeSeverity(kind: string): NoticeSeverity {
  if (!Object.hasOwn(NOTICE_SEVERITY, kind)) {
    return "action";
  }
  return NOTICE_SEVERITY[kind] === "info" ? "info" : "action";
}

/** `kind`の通知をConsoleから解決できるかを返す。 */
export function isNoticeResolvable(kind: string): boolean {
  return !UNRESOLVABLE_NOTICE_KINDS.includes(kind);
}
