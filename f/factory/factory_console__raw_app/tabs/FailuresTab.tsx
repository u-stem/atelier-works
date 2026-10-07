import React, { useState } from "react";
import { Skeleton } from "../components/Skeleton";
import { describeError, retryWorkItem } from "../lib/api";
import { describeRetry } from "../lib/retryResult";
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

  // 結果の文言は、表示する側(失敗の行)と同じ`job_failure_id`で引けるように記録する。
  async function handleRetry(
    jobFailureId: number,
    workItemId: number | null,
  ): Promise<void> {
    if (workItemId === null || pendingId !== null) {
      return;
    }
    setPendingId(workItemId);
    try {
      const result = await retryWorkItem(workItemId);
      setRowMessage((previous) => ({
        ...previous,
        [jobFailureId]: describeRetry(result),
      }));
      reload();
    } catch (caught) {
      setRowMessage((previous) => ({
        ...previous,
        [jobFailureId]: describeError(caught),
      }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="tab failures-tab">
      <div className="tab-toolbar">
        <h2>失敗一覧</h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={reload}
          disabled={loading}
          aria-label="失敗一覧を更新"
        >
          更新
        </button>
      </div>
      {loading && <Skeleton rows={3} />}
      {error !== null && <p className="error-banner">{error}</p>}
      {!loading && rows.length === 0 && error === null && (
        <div className="empty-state">
          <p className="empty-state-title">失敗はありません。</p>
          <p className="empty-state-hint">
            ジョブが失敗すると、ここに詳細と再実行の操作が表示されます。
          </p>
        </div>
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
              className="btn btn-primary"
              onClick={() => {
                void handleRetry(row.job_failure_id, row.work_item_id);
              }}
              disabled={row.work_item_id === null || pendingId !== null}
              aria-label="この作業項目を再実行"
            >
              {pendingId === row.work_item_id ? "実行中..." : "再実行"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
