import React, { useState } from "react";
import { describeError, retryWorkItem } from "../lib/api";
import { toFailureRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function FailuresTab(): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "failures",
    toFailureRow,
    { limit: 200, days: 30 },
  );
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<number, string>>({});

  async function handleRetry(workItemId: number | null): Promise<void> {
    if (workItemId === null || pendingId !== null) {
      return;
    }
    setPendingId(workItemId);
    try {
      await retryWorkItem(workItemId);
      setRowMessage((previous) => ({
        ...previous,
        [workItemId]: "再実行を開始しました",
      }));
      reload();
    } catch (caught) {
      setRowMessage((previous) => ({
        ...previous,
        [workItemId]: describeError(caught),
      }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="tab failures-tab">
      <div className="tab-toolbar">
        <h2>失敗一覧</h2>
        <button type="button" onClick={reload} disabled={loading}>
          更新
        </button>
      </div>
      {loading && <p>読み込み中...</p>}
      {error !== null && <p className="error-banner">{error}</p>}
      {!loading && rows.length === 0 && error === null && (
        <p>失敗はありません。</p>
      )}
      <ul className="failure-list">
        {rows.map((row) => (
          <li key={row.job_failure_id} className="failure-item">
            <div className="failure-meta">
              {row.owner !== null && row.repo !== null
                ? `${row.owner}/${row.repo}`
                : "(不明なリポジトリ)"}
              {row.issue_number !== null && ` #${row.issue_number}`} ・
              work_item_id {row.work_item_id ?? "-"} ・{" "}
              {formatDateTime(row.occurred_at)}
            </div>
            <div className="failure-path">
              {row.flow_path}
              {row.step !== null ? ` / ${row.step}` : ""}
            </div>
            <pre className="failure-error">{row.error}</pre>
            {rowMessage[row.job_failure_id] !== undefined && (
              <p className="action-message">{rowMessage[row.job_failure_id]}</p>
            )}
            <button
              type="button"
              onClick={() => {
                void handleRetry(row.work_item_id);
              }}
              disabled={row.work_item_id === null || pendingId !== null}
            >
              {pendingId === row.work_item_id ? "実行中..." : "再実行"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
