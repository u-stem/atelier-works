import React, { useState } from "react";
import { Markdown } from "../components/Markdown";
import { RequirementsDocumentLoader } from "../components/RequirementsDocument";
import { Skeleton } from "../components/Skeleton";
import { decideApproval, describeError } from "../lib/api";
import { kindLabel } from "../lib/inboxLabels";
import { type InboxRow, toInboxRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

/** Whether an issue_proposal row is "approved but the Issue was never
 * created" (team-lead fix round, "Keep incomplete approvals visible in
 * Inbox") — 承認 is safe to re-run (approval_decide.ts's dispatch classifies
 * it as an idempotent retry and resumes the create-or-reuse step), but 却下
 * no longer makes sense once approval is already on record, so that action
 * is hidden for this row. */
function isIncompleteProposal(row: InboxRow): boolean {
  return (
    row.kind === "issue_proposal" &&
    row.proposal_status === "approved" &&
    row.created_issue_number === null
  );
}

export function InboxTab({
  onOpenAudit,
}: {
  /** Opens the 監査 tab and selects the audit report this proposal came
   * from (App.tsx wires this to `setAuditTarget` + `setActiveTab("audit")`
   * — see AuditTab.tsx's `initialWorkItemId` prop). */
  onOpenAudit: (workItemId: number) => void;
}): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "inbox",
    toInboxRow,
    { limit: 200 },
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [withFactoryLabel, setWithFactoryLabel] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const selected =
    rows.find((row) => row.approval_request_id === selectedId) ?? null;
  const incomplete = selected !== null && isIncompleteProposal(selected);

  function selectRow(approvalRequestId: number): void {
    setSelectedId(approvalRequestId);
    setReason("");
    setNote("");
    setWithFactoryLabel(false);
    setActionError(null);
    setActionMessage(null);
  }

  async function handleDecision(action: "approve" | "reject"): Promise<void> {
    if (selected === null || pendingId !== null) {
      return;
    }
    if (action === "reject" && reason.trim().length === 0) {
      setActionError("却下する場合は理由を入力してください");
      return;
    }
    setPendingId(selected.approval_request_id);
    setActionError(null);
    setActionMessage(null);
    try {
      const options =
        selected.kind === "issue_proposal"
          ? { with_factory_label: withFactoryLabel }
          : {};
      await decideApproval(
        selected.approval_request_id,
        action,
        reason,
        note,
        options,
      );
      setActionMessage(action === "approve" ? "承認しました" : "却下しました");
      setSelectedId(null);
      reload();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="tab inbox-tab">
      <div className="inbox-list">
        <div className="tab-toolbar">
          <h2>承認待ち一覧</h2>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={reload}
            disabled={loading}
            aria-label="承認待ち一覧を更新"
          >
            更新
          </button>
        </div>
        {loading && <Skeleton />}
        {error !== null && <p className="error-banner">{error}</p>}
        {!loading && rows.length === 0 && error === null && (
          <div className="empty-state">
            <p className="empty-state-title">承認待ちの項目はありません。</p>
            <p className="empty-state-hint">
              新しい要件定義・Issue化提案・改善提案が届くと、ここに表示されます。
            </p>
          </div>
        )}
        <ul className="inbox-items">
          {rows.map((row) => {
            const rowIncomplete = isIncompleteProposal(row);
            const title =
              row.kind === "requirements"
                ? (row.title ?? `#${row.issue_number ?? "-"}`)
                : row.proposal_title;
            return (
              <li key={row.approval_request_id}>
                <button
                  type="button"
                  className={
                    row.approval_request_id === selectedId ? "selected" : ""
                  }
                  onClick={() => selectRow(row.approval_request_id)}
                >
                  <div className="inbox-item-title">
                    <span className="status-pill status-pill--neutral">
                      {kindLabel(row)}
                    </span>{" "}
                    {title}
                    {rowIncomplete && (
                      <span className="status-pill status-pill--warning">
                        起票未完了
                      </span>
                    )}
                  </div>
                  <div className="inbox-item-meta">
                    {row.kind === "requirements" ? (
                      <>
                        {row.owner}/{row.repo}#{row.issue_number ?? "-"} ・
                        attempt {row.draft_attempt} ・ work_item_id{" "}
                        {row.work_item_id}
                      </>
                    ) : (
                      <>
                        {row.owner}/{row.repo} ・{" "}
                        {row.origin === "audit" ? (
                          <>監査 {row.period_label ?? "-"}</>
                        ) : (
                          <>PR #{row.pr_number ?? "-"}</>
                        )}
                        {row.title !== null && <> ・ {row.title}</>}
                        {row.claimed_by !== null && (
                          <> ・ 担当: {row.claimed_by}</>
                        )}
                      </>
                    )}
                  </div>
                  {row.kind === "requirements" &&
                    row.summary !== null &&
                    row.summary.length > 0 && (
                      <div className="inbox-item-summary">{row.summary}</div>
                    )}
                  <div className="inbox-item-meta">
                    依頼: {formatDateTime(row.requested_at)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="inbox-detail">
        {selected === null ? (
          <div className="empty-state">
            <p className="empty-state-title">
              左の一覧から項目を選択してください。
            </p>
            <p className="empty-state-hint">
              内容の確認と承認 / 却下の操作がここに表示されます。
            </p>
          </div>
        ) : selected.kind === "requirements" ? (
          <>
            <RequirementsDocumentLoader
              workItemId={selected.work_item_id}
              attempt={selected.draft_attempt}
            />
            <h3>承認 / 却下</h3>
            <label className="field">
              却下理由(却下する場合は必須)
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
              />
            </label>
            <label className="field">
              補足(任意)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
              />
            </label>
            {actionError !== null && (
              <p className="error-banner">{actionError}</p>
            )}
            {actionMessage !== null && (
              <p className="success-banner">{actionMessage}</p>
            )}
            {pendingId !== null && <p>実行中です…</p>}
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  void handleDecision("approve");
                }}
                disabled={pendingId !== null}
                aria-label="この作業項目を承認"
              >
                承認
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void handleDecision("reject");
                }}
                disabled={pendingId !== null}
                aria-label="この作業項目を却下"
              >
                却下
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              {selected.proposal_title}
              {incomplete && (
                <span className="status-pill status-pill--warning">
                  起票未完了
                </span>
              )}
            </h2>
            <p className="inbox-item-meta">
              {selected.owner}/{selected.repo} ・{" "}
              {selected.origin === "audit" ? (
                <>
                  監査 {selected.period_label ?? "-"}
                  {" ・ "}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onOpenAudit(selected.work_item_id)}
                  >
                    レポートを開く
                  </button>
                </>
              ) : (
                <>PR #{selected.pr_number ?? "-"}</>
              )}
              {selected.title !== null && <> ・ {selected.title}</>}
              {" ・ "}approval_request_id {selected.approval_request_id}
            </p>
            <h3>提案内容</h3>
            <Markdown markdown={selected.proposal_body} />
            <h3>承認 / 却下</h3>
            {incomplete ? (
              <p className="empty-state-hint">
                前回の承認でIssueの起票に失敗しました。承認を再実行するとIssueを起票します。
              </p>
            ) : (
              <>
                {selected.origin !== "audit" ||
                selected.factory_label_available ? (
                  <label className="field-inline">
                    <input
                      type="checkbox"
                      checked={withFactoryLabel}
                      onChange={(event) =>
                        setWithFactoryLabel(event.target.checked)
                      }
                    />
                    起票と同時にfactoryラベルを付けて要件定義に進める
                  </label>
                ) : (
                  <p className="empty-state-hint">
                    factory_repoがrepo_allowlistに含まれていないため、起票のみ行います。
                  </p>
                )}
                <label className="field">
                  却下理由(却下する場合は必須)
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                  />
                </label>
              </>
            )}
            {actionError !== null && (
              <p className="error-banner">{actionError}</p>
            )}
            {actionMessage !== null && (
              <p className="success-banner">{actionMessage}</p>
            )}
            {pendingId !== null && <p>実行中です…</p>}
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  void handleDecision("approve");
                }}
                disabled={pendingId !== null}
                aria-label="この提案を承認"
              >
                承認
              </button>
              {!incomplete && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    void handleDecision("reject");
                  }}
                  disabled={pendingId !== null}
                  aria-label="この提案を却下"
                >
                  却下
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
