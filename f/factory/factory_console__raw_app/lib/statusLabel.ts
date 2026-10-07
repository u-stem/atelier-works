// 作業項目の状態の値(`work_item_status`やパイプラインの`status`)を、
// 表示用の日本語に変える。
// `PipelineTab.tsx`と`AuditTab.tsx`が状態の列を描くときに使う。
// 表に無い状態(表の更新が追いついていない新しい状態など)は、
// 表示が空にならないよう元の値をそのまま返す。

const STATUS_LABELS: Record<string, string> = {
  auditing: "監査中",
  audited: "監査完了",
  awaiting_approval: "承認待ち",
  picked: "着手",
  failed: "失敗",
  needs_human: "要人手",
  approved: "承認済み",
  rejected: "却下",
  expired: "期限切れ",
  cancelled: "取消",
  implementing: "実装中",
  pr_open: "PR作成済み",
  reviewed: "レビュー済み",
  rereview_requested: "再レビュー依頼済み",
  blocked: "ブロック",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
