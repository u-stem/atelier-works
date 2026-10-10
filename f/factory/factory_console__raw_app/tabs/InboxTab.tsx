import React, { useMemo, useState } from "react";
import { Markdown } from "../components/Markdown";
import { RequirementsDocumentLoader } from "../components/RequirementsDocument";
import { Skeleton } from "../components/Skeleton";
import { decideApproval, describeError } from "../lib/api";
import { defaultWithFactoryLabel, kindLabel } from "../lib/inboxLabels";
import { type InboxRow, toInboxRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

/**
 * issue_proposalの行が「承認済みだがIssueを作れていない」状態かを返す。
 * この行は承認タブに残す。承認はやり直しても安全だが(`approval_decide.ts`が
 * 冪等な再試行と判定し、作成か再利用のstepから再開する)、承認が記録済み
 * なので却下はもう意味が無く、この行では却下の操作を隠す。
 */
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
  /**
   * 監査タブを開き、この提案の元になった監査レポートを選ぶ。
   * `App.tsx`が`setAuditTarget`と`setActiveTab("audit")`につなぐ
   * (`AuditTab.tsx`の`initialWorkItemId`を参照)。
   */
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
  // `Markdown`のcontextの値になるので、描画のたびに作り直さない。
  const selectedOwner = selected?.owner;
  const selectedRepo = selected?.repo;
  const selectedRepoRef = useMemo(
    () =>
      selectedOwner === undefined || selectedRepo === undefined
        ? null
        : { owner: selectedOwner, repo: selectedRepo },
    [selectedOwner, selectedRepo],
  );

  function selectRow(approvalRequestId: number): void {
    const row = rows.find(
      (candidate) => candidate.approval_request_id === approvalRequestId,
    );
    setSelectedId(approvalRequestId);
    setReason("");
    setNote("");
    setWithFactoryLabel(
      row === undefined ? false : defaultWithFactoryLabel(row),
    );
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
            <Markdown
              markdown={selected.proposal_body}
              repo={selectedRepoRef}
            />
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
