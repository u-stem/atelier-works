import React from "react";
import { Skeleton } from "../components/Skeleton";
import { toNoticeRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function NoticesTab(): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "notices",
    toNoticeRow,
    { limit: 200 },
  );

  return (
    <div className="tab notices-tab">
      <div className="tab-toolbar">
        <h2>要対応通知</h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={reload}
          disabled={loading}
          aria-label="通知一覧を更新"
        >
          更新
        </button>
      </div>
      {loading && <Skeleton rows={3} />}
      {error !== null && <p className="error-banner">{error}</p>}
      {!loading && rows.length === 0 && error === null && (
        <div className="empty-state">
          <p className="empty-state-title">未解決の通知はありません。</p>
          <p className="empty-state-hint">
            対応が必要な通知が発生すると、ここに表示されます。
          </p>
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>種別</th>
                <th>内容</th>
                <th>発生</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.notice_id}>
                  <td>{row.kind}</td>
                  <td>{row.message}</td>
                  <td>{formatDateTime(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
