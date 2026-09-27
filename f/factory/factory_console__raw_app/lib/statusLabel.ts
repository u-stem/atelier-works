// Maps a raw `work_item_status`/pipeline-`status` column value to its
// Japanese label for display — used by PipelineTab.tsx and AuditTab.tsx
// wherever a status column is rendered. An unmapped status (e.g. one this
// table hasn't been updated for yet) falls back to the raw value so the UI
// still shows something instead of blanking.

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
  reviewed: "レビュー済み",
  rereview_requested: "再レビュー依頼済み",
  blocked: "ブロック",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
