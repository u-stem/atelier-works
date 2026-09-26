import React, { useState } from "react";
import { Markdown } from "../components/Markdown";
import { Skeleton } from "../components/Skeleton";
import { decideApproval, decideIssueProposal, describeError } from "../lib/api";
import { toInboxRow, toIssueProposalRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function InboxTab(): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "inbox",
    toInboxRow,
    { limit: 200 },
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const selected = rows.find((row) => row.work_item_id === selectedId) ?? null;

  function selectRow(workItemId: number): void {
    setSelectedId(workItemId);
    setReason("");
    setNote("");
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
    setPendingId(selected.work_item_id);
    setActionError(null);
    setActionMessage(null);
    try {
      await decideApproval(selected.work_item_id, action, reason, note);
      setActionMessage(action === "approve" ? "承認しました" : "却下しました");
      setSelectedId(null);
      reload();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setPendingId(null);
    }
  }

  const {
    rows: proposalRows,
    loading: proposalsLoading,
    error: proposalsError,
    reload: reloadProposals,
  } = useConsoleQuery("issue_proposals", toIssueProposalRow, { limit: 200 });
  const [selectedProposalId, setSelectedProposalId] = useState<number | null>(
    null,
  );
  const [proposalReason, setProposalReason] = useState("");
  const [proposalWithLabel, setProposalWithLabel] = useState(false);
  const [proposalPendingId, setProposalPendingId] = useState<number | null>(
    null,
  );
  const [proposalActionError, setProposalActionError] = useState<string | null>(
    null,
  );
  const [proposalActionMessage, setProposalActionMessage] = useState<
    string | null
  >(null);

  const selectedProposal =
    proposalRows.find((row) => row.issue_proposal_id === selectedProposalId) ??
    null;

  function selectProposal(issueProposalId: number): void {
    setSelectedProposalId(issueProposalId);
    setProposalReason("");
    setProposalWithLabel(false);
    setProposalActionError(null);
    setProposalActionMessage(null);
  }

  async function handleProposalDecision(
    action: "approve" | "reject",
  ): Promise<void> {
    if (selectedProposal === null || proposalPendingId !== null) {
      return;
    }
    if (action === "reject" && proposalReason.trim().length === 0) {
      setProposalActionError("却下する場合は理由を入力してください");
      return;
    }
    setProposalPendingId(selectedProposal.issue_proposal_id);
    setProposalActionError(null);
    setProposalActionMessage(null);
    try {
      await decideIssueProposal(
        selectedProposal.issue_proposal_id,
        action,
        proposalReason,
        proposalWithLabel,
      );
      setProposalActionMessage(
        action === "approve" ? "承認しました" : "却下しました",
      );
      setSelectedProposalId(null);
      reloadProposals();
    } catch (caught) {
      setProposalActionError(describeError(caught));
    } finally {
      setProposalPendingId(null);
    }
  }

  return (
    <>
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
              <p className="empty-state-title">
                承認待ちの作業項目はありません。
              </p>
              <p className="empty-state-hint">
                新しい要件定義が提出されると、ここに表示されます。
              </p>
            </div>
          )}
          <ul className="inbox-items">
            {rows.map((row) => (
              <li key={row.work_item_id}>
                <button
                  type="button"
                  className={row.work_item_id === selectedId ? "selected" : ""}
                  onClick={() => selectRow(row.work_item_id)}
                >
                  <div className="inbox-item-title">
                    {row.title ?? `#${row.issue_number ?? "-"}`}
                  </div>
                  <div className="inbox-item-meta">
                    {row.owner}/{row.repo}#{row.issue_number ?? "-"} ・ attempt{" "}
                    {row.attempt} ・ work_item_id {row.work_item_id}
                  </div>
                  <div className="inbox-item-meta">
                    更新: {formatDateTime(row.updated_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="inbox-detail">
          {selected === null ? (
            <div className="empty-state">
              <p className="empty-state-title">
                左の一覧から作業項目を選択してください。
              </p>
              <p className="empty-state-hint">
                要件定義の内容と承認 / 却下の操作がここに表示されます。
              </p>
            </div>
          ) : (
            <>
              <h2>{selected.title ?? "(タイトルなし)"}</h2>
              <p className="inbox-item-meta">
                {selected.owner}/{selected.repo}
                {selected.issue_url !== null && (
                  <>
                    {" "}
                    ・{" "}
                    <a
                      href={selected.issue_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Issue を開く
                    </a>
                  </>
                )}{" "}
                ・ work_item_id {selected.work_item_id} ・ attempt{" "}
                {selected.attempt}
              </p>
              <h3>要約</h3>
              <p>{selected.summary}</p>
              <h3>要件定義</h3>
              <Markdown text={selected.markdown} />
              {selected.diagrams.length > 0 && (
                <>
                  <h3>図</h3>
                  {selected.diagrams.map((diagram) => (
                    <div key={diagram.name} className="diagram-viewer">
                      <p>{diagram.name}</p>
                      {diagram.viewer_url !== null ? (
                        <iframe
                          title={diagram.name}
                          src={diagram.viewer_url}
                          className="diagram-iframe"
                        />
                      ) : (
                        <p>図を表示できませんでした。</p>
                      )}
                    </div>
                  ))}
                </>
              )}
              {selected.open_questions.length > 0 && (
                <>
                  <h3>未確定事項</h3>
                  <ul>
                    {selected.open_questions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </>
              )}
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
          )}
        </div>
      </div>
      <div className="tab inbox-tab">
        <div className="inbox-list">
          <div className="tab-toolbar">
            <h2>Issue化提案</h2>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={reloadProposals}
              disabled={proposalsLoading}
              aria-label="Issue化提案一覧を更新"
            >
              更新
            </button>
          </div>
          {proposalsLoading && <Skeleton />}
          {proposalsError !== null && (
            <p className="error-banner">{proposalsError}</p>
          )}
          {!proposalsLoading &&
            proposalRows.length === 0 &&
            proposalsError === null && (
              <div className="empty-state">
                <p className="empty-state-title">
                  保留中のIssue化提案はありません
                </p>
              </div>
            )}
          <ul className="inbox-items">
            {proposalRows.map((row) => (
              <li key={row.issue_proposal_id}>
                <button
                  type="button"
                  className={
                    row.issue_proposal_id === selectedProposalId
                      ? "selected"
                      : ""
                  }
                  onClick={() => selectProposal(row.issue_proposal_id)}
                >
                  <div className="inbox-item-title">{row.title}</div>
                  <div className="inbox-item-meta">
                    {row.owner}/{row.repo} ・ PR #{row.pr_number ?? "-"}
                    {row.pr_title !== null && <> ・ {row.pr_title}</>}
                  </div>
                  <div className="inbox-item-meta">
                    {row.claimed_by !== null && <>担当: {row.claimed_by} ・ </>}
                    作成: {formatDateTime(row.created_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="inbox-detail">
          {selectedProposal === null ? (
            <div className="empty-state">
              <p className="empty-state-title">
                左の一覧からIssue化提案を選択してください。
              </p>
              <p className="empty-state-hint">
                提案内容の確認と承認 / 却下の操作がここに表示されます。
              </p>
            </div>
          ) : (
            <>
              <h2>{selectedProposal.title}</h2>
              <p className="inbox-item-meta">
                {selectedProposal.owner}/{selectedProposal.repo} ・ PR #
                {selectedProposal.pr_number ?? "-"}
                {selectedProposal.pr_title !== null && (
                  <> ・ {selectedProposal.pr_title}</>
                )}
                {" ・ "}issue_proposal_id {selectedProposal.issue_proposal_id}
              </p>
              <h3>提案内容</h3>
              <Markdown text={selectedProposal.body} />
              <h3>承認 / 却下</h3>
              <label className="field-inline">
                <input
                  type="checkbox"
                  checked={proposalWithLabel}
                  onChange={(event) =>
                    setProposalWithLabel(event.target.checked)
                  }
                />
                起票と同時にfactoryラベルを付けて要件定義に進める
              </label>
              <label className="field">
                却下理由(却下する場合は必須)
                <textarea
                  value={proposalReason}
                  onChange={(event) => setProposalReason(event.target.value)}
                  rows={3}
                />
              </label>
              {proposalActionError !== null && (
                <p className="error-banner">{proposalActionError}</p>
              )}
              {proposalActionMessage !== null && (
                <p className="success-banner">{proposalActionMessage}</p>
              )}
              {proposalPendingId !== null && <p>実行中です…</p>}
              <div className="button-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void handleProposalDecision("approve");
                  }}
                  disabled={proposalPendingId !== null}
                  aria-label="この提案を承認"
                >
                  承認
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    void handleProposalDecision("reject");
                  }}
                  disabled={proposalPendingId !== null}
                  aria-label="この提案を却下"
                >
                  却下
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
