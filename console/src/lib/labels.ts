// 状態・種別・通知の種類・承認の種類を、画面に出す日本語にする対応表。
// 画面は生のコードや英語のフィールド名を出さない。表に無い値(backendが足した新しい値)は、
// 元の文字列を出さず、決まった文言にする。

export const UNKNOWN_STATUS_LABEL = "不明な状態";
export const UNKNOWN_NOTICE_LABEL = "通知";

const STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  ["picked", "着手"],
  ["requirements_generating", "要件定義の生成中"],
  ["awaiting_approval", "承認待ち"],
  ["approved", "承認済み"],
  ["rejected", "却下"],
  ["implementing", "実装中"],
  ["pr_open", "PR作成済み"],
  ["reviewing", "レビュー中"],
  ["reviewed", "レビュー済み"],
  ["fixing", "修正中"],
  ["rereview_requested", "再レビュー依頼済み"],
  ["blocked", "ブロック"],
  ["needs_human", "人の対応待ち"],
  ["failed", "失敗"],
  ["expired", "期限切れ"],
  ["cancelled", "取消"],
  ["auditing", "監査中"],
  ["audited", "監査完了"],
]);

const WORK_ITEM_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ["issue", "Issue"],
  ["pr_review", "PRレビュー"],
  ["pr_fix", "PRの修正"],
  ["audit", "監査"],
]);

const NOTICE_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ["approval_notify_failed", "承認依頼の通知の失敗"],
  ["claim_race_lost", "着手の競合"],
  ["supersede_failed", "古い承認依頼の置き換えの失敗"],
  ["cleanup_worktrees_skipped", "作業ディレクトリの掃除の見送り"],
  ["workspace_disk_usage", "作業領域の容量"],
  ["fix_feedback_association_excluded", "修正の指摘の除外"],
  ["labeler_denied", "ラベル付与者の拒否"],
  ["intake_refreshed", "取り込み内容の更新"],
  ["labeler_check_limit", "ラベル付与者の判定不能"],
  ["fork_head_denied", "forkのPRのレビューの見送り"],
  // 種類名を改める前に解決済みになった通知が、保持期間のあいだ履歴に残る。
  ["labeler_association_denied", "ラベル付与者の拒否"],
  ["unsandboxed_check_commands", "隔離されない検査コマンド"],
  ["implement_needs_human", "実装の人手待ち"],
  ["approval_comment_failed", "承認コメントの投稿失敗"],
  ["implement_launch_failed", "実装の起動の失敗"],
  ["fix_reply_post_failed", "修正の返信の投稿失敗"],
  ["pr_fix_reviewer_request_failed", "再レビュー依頼の失敗"],
  ["issue_proposal_record_failed", "Issue提案の記録の失敗"],
  ["claim_assignee_missing", "担当者の未設定"],
  ["pr_trigger_label_left_removed", "PRのトリガーラベルの外れ"],
  ["deployed_sha_mismatch", "反映された版の不一致"],
  ["owner_id_mismatch", "オーナーの照合の失敗"],
  ["host_action_required", "ホスト側の作業"],
  ["cleanup_db_failed", "データベースの掃除の失敗"],
  ["cleanup_worktree_busy", "作業ディレクトリの使用中"],
  ["check_slot_skipped", "検査の枠の飛ばし"],
  ["check_slot_record_unreadable", "検査の枠の記録の退避"],
  ["check_runtime_unsafe", "検査の実行環境の問題"],
  ["console_fetch_failed", "Consoleの取り込みの失敗"],
  ["console_fetch_stale", "Consoleの取り込みの停止"],
  ["console_worker_missing", "Console専用workerの不在"],
  ["console_worker_check_failed", "Console専用workerの確認の失敗"],
  ["schedule_failing", "定期実行の失敗"],
  ["schedule_failing_check_failed", "定期実行の確認の失敗"],
  ["drawio_viewer_bump_held", "draw.ioのビューアの更新の保留"],
]);

/** 作業項目の状態の日本語。表に無い状態は`UNKNOWN_STATUS_LABEL`にする。 */
export function workItemStatusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? UNKNOWN_STATUS_LABEL;
}

/** 作業項目の種別の日本語。表に無い種別は「その他」にする。 */
export function workItemKindLabel(kind: string): string {
  return WORK_ITEM_KIND_LABELS.get(kind) ?? "その他";
}

/**
 * 承認依頼の種類の日本語。
 * Issue提案は、監査から出たものを「改善提案」、それ以外を「Issue化提案」とする。
 */
export function approvalKindLabel(kind: string, origin: string | null): string {
  if (kind === "requirements") {
    return "要件定義";
  }
  if (kind === "issue_proposal") {
    return origin === "audit" ? "改善提案" : "Issue化提案";
  }
  return "承認依頼";
}

/**
 * 承認依頼の状態の日本語。
 * 承認済みのIssue提案は、承認を記録した後でIssueを作れなかった行が一覧に残る。
 * そのため「Issue作成待ち」と添える。表に無い状態は`UNKNOWN_STATUS_LABEL`にする。
 */
export function approvalStatusLabel(status: string, kind: string): string {
  switch (status) {
    case "pending":
      return "承認待ち";
    case "approved":
      return kind === "issue_proposal" ? "承認済み(Issue作成待ち)" : "承認済み";
    case "rejected":
      return "却下";
    case "expired":
      return "期限切れ";
    default:
      return UNKNOWN_STATUS_LABEL;
  }
}

/** 通知の種類の日本語。表に無い種類は`UNKNOWN_NOTICE_LABEL`にする。 */
export function noticeKindLabel(kind: string): string {
  return NOTICE_KIND_LABELS.get(kind) ?? UNKNOWN_NOTICE_LABEL;
}

const DEPLOYMENT_RESULT_LABELS: ReadonlyMap<string, string> = new Map([
  ["success", "反映済み"],
  ["failed", "失敗"],
]);

const PULL_REQUEST_ORIGIN_LABELS: ReadonlyMap<string, string> = new Map([
  ["factory", "Software Factory"],
  ["human", "人"],
]);

/** 反映の結果の日本語。表に無い結果は`UNKNOWN_STATUS_LABEL`にする。 */
export function deploymentResultLabel(result: string): string {
  return DEPLOYMENT_RESULT_LABELS.get(result) ?? UNKNOWN_STATUS_LABEL;
}

/**
 * PRを作ったのが誰かの日本語。
 * マージのコミットからブランチを読めなかったPRと、表に無い値は「不明」にする。
 * 確かな情報が無いのに、どちらかに振り分けないためである。
 */
export function pullRequestOriginLabel(origin: string): string {
  return PULL_REQUEST_ORIGIN_LABELS.get(origin) ?? "不明";
}

/** 反映にホスト側の作業(`infra/`と`mise.toml`の変更の反映)が要るかの日本語。 */
export function hostActionLabel(needsHostAction: boolean): string {
  return needsHostAction ? "ホストの作業が必要" : "ホストの作業は不要";
}

/** 「作業項目 #27」の形。 */
export function workItemRef(workItemId: number): string {
  return `作業項目 #${workItemId}`;
}

/** 「試行 1」の形。 */
export function attemptRef(attempt: number): string {
  return `試行 ${attempt}`;
}
