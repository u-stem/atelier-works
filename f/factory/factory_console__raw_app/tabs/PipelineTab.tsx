import React, { useMemo, useState } from "react";
import type { PipelineRow } from "../lib/types";
import { toPipelineRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

const ALL = "__all__";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

type IssueOrPrLink = { readonly label: string; readonly url: string };

function issueOrPrLink(row: PipelineRow): IssueOrPrLink | null {
  if (row.issue_url !== null && row.issue_number !== null) {
    return { label: `#${row.issue_number}`, url: row.issue_url };
  }
  if (row.pr_number !== null) {
    return {
      label: `PR #${row.pr_number}`,
      url: `https://github.com/${row.owner}/${row.repo}/pull/${row.pr_number}`,
    };
  }
  return null;
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
        <button type="button" onClick={reload} disabled={loading}>
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
                {status}
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
      {loading && <p>読み込み中...</p>}
      {error !== null && <p className="error-banner">{error}</p>}
      <table className="data-table">
        <thead>
          <tr>
            <th>work_item_id</th>
            <th>種別</th>
            <th>ステータス</th>
            <th>リポジトリ</th>
            <th>Issue/PR</th>
            <th>attempt</th>
            <th>fix_round</th>
            <th>更新</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => {
            const link = issueOrPrLink(row);
            return (
              <tr key={row.work_item_id}>
                <td>{row.work_item_id}</td>
                <td>{row.kind}</td>
                <td>{row.status}</td>
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
                <td>{row.attempt}</td>
                <td>{row.fix_round}</td>
                <td>{formatDateTime(row.updated_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!loading && filtered.length === 0 && (
        <p>該当する作業項目はありません。</p>
      )}
    </div>
  );
}
