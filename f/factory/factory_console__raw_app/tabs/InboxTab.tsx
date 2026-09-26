import React, { useState } from "react";
import { Markdown } from "../components/Markdown";
import { decideApproval, describeError } from "../lib/api";
import { toInboxRow } from "../lib/types";
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

  return (
    <div className="tab inbox-tab">
      <div className="inbox-list">
        <div className="tab-toolbar">
          <h2>承認待ち一覧</h2>
          <button type="button" onClick={reload} disabled={loading}>
            更新
          </button>
        </div>
        {loading && <p>読み込み中...</p>}
        {error !== null && <p className="error-banner">{error}</p>}
        {!loading && rows.length === 0 && error === null && (
          <p>承認待ちの作業項目はありません。</p>
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
          <p>左の一覧から作業項目を選択してください。</p>
        ) : (
          <>
            <h2>{selected.title ?? "(タイトルなし)"}</h2>
            <p className="inbox-item-meta">
              {selected.owner}/{selected.repo}
              {selected.issue_url !== null && (
                <>
                  {" "}
                  ・{" "}
                  <a href={selected.issue_url} target="_blank" rel="noreferrer">
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
                onClick={() => {
                  void handleDecision("approve");
                }}
                disabled={pendingId !== null}
              >
                承認
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDecision("reject");
                }}
                disabled={pendingId !== null}
              >
                却下
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
