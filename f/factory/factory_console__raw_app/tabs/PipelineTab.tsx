import React, { useMemo, useState } from "react";
import { Skeleton } from "../components/Skeleton";
import { issueOrPrLink, prLink, statusVariant } from "../lib/pipelineView";
import { statusLabel } from "../lib/statusLabel";
import type { PipelineRow } from "../lib/types";
import { toPipelineRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

const ALL = "__all__";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function PipelineTab(): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "pipeline",
    toPipelineRow,
    { limit: 500, days: 90 },
  );
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [repoFilter, setRepoFilter] = useState(ALL);

  const statuses = useMemo(
    () => Array.from(new Set(rows.map((row) => row.status))).sort(),
    [rows],
  );
  const repos = useMemo(
    () =>
      Array.from(new Set(rows.map((row) => `${row.owner}/${row.repo}`))).sort(),
    [rows],
  );

  const filtered = rows.filter((row) => {
    if (statusFilter !== ALL && row.status !== statusFilter) {
      return false;
    }
    if (repoFilter !== ALL && `${row.owner}/${row.repo}` !== repoFilter) {
      return false;
    }
    return true;
  });

  return (
    <div className="tab pipeline-tab">
      <div className="tab-toolbar">
        <h2>パイプライン</h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={reload}
          disabled={loading}
          aria-label="パイプライン一覧を更新"
        >
          更新
        </button>
      </div>
      <div className="filter-row">
        <label className="field-inline">
          ステータス
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value={ALL}>すべて</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          リポジトリ
          <select
            value={repoFilter}
            onChange={(event) => setRepoFilter(event.target.value)}
          >
            <option value={ALL}>すべて</option>
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && <Skeleton rows={5} />}
      {error !== null && <p className="error-banner">{error}</p>}
      {!loading && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="numeric">work_item_id</th>
                <th>種別</th>
                <th>ステータス</th>
                <th>リポジトリ</th>
                <th>Issue/PR</th>
                <th>ブランチ</th>
                <th>PR</th>
                <th className="numeric">attempt</th>
                <th className="numeric">fix_round</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const link = issueOrPrLink(row);
                const pr = prLink(row.pr_url);
                return (
                  <tr key={row.work_item_id}>
                    <td className="numeric">{row.work_item_id}</td>
                    <td>{row.kind}</td>
                    <td>
                      <span
                        className={`status-pill status-pill--${statusVariant(row.status)}`}
                        title={row.status}
                      >
                        {statusLabel(row.status)}
                      </span>
                    </td>
                    <td>
                      {row.owner}/{row.repo}
                    </td>
                    <td>
                      {link !== null ? (
                        <a href={link.url} target="_blank" rel="noreferrer">
                          {link.label}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{row.branch ?? "-"}</td>
                    <td>
                      {pr !== null ? (
                        <a href={pr.url} target="_blank" rel="noreferrer">
                          {pr.label}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="numeric">{row.attempt}</td>
                    <td className="numeric">{row.fix_round}</td>
                    <td>{formatDateTime(row.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">該当する作業項目はありません。</p>
          <p className="empty-state-hint">
            フィルタ条件を変更するか、更新して最新の状態を確認してください。
          </p>
        </div>
      )}
    </div>
  );
}
