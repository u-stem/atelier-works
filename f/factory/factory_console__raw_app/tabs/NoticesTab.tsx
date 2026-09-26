import React from "react";
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
        <button type="button" onClick={reload} disabled={loading}>
          更新
        </button>
      </div>
      {loading && <p>読み込み中...</p>}
      {error !== null && <p className="error-banner">{error}</p>}
      {!loading && rows.length === 0 && error === null && (
        <p>未解決の通知はありません。</p>
      )}
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
  );
}
