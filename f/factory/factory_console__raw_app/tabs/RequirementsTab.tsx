import React, { useEffect, useState } from "react";
import { RequirementsDocumentLoader } from "../components/RequirementsDocument";
import { Skeleton } from "../components/Skeleton";
import { collectDeepLinkCandidates, parseDeepLink } from "../lib/deepLink";
import {
  type RequirementsIndexRow,
  toRequirementsIndexRow,
} from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function RequirementsTab(): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "requirements_index",
    toRequirementsIndexRow,
    { limit: 500, days: 3650 },
  );
  const [selected, setSelected] = useState<{
    workItemId: number;
    attempt: number | null;
  } | null>(null);
  const [workItemIdFilter, setWorkItemIdFilter] = useState("");

  const parsedFilterValue = Number(workItemIdFilter);
  const parsedWorkItemIdFilter =
    workItemIdFilter.trim().length > 0 && Number.isInteger(parsedFilterValue)
      ? parsedFilterValue
      : null;
  const filteredRows =
    parsedWorkItemIdFilter === null
      ? rows
      : rows.filter((row) => row.work_item_id === parsedWorkItemIdFilter);

  // ディープリンク。`#requirements/<id>[/attempt-<k>]`付きで投稿された
  // Consoleのリンクから来たときは、一覧から手で選ばせず、一覧の読み込み後に
  // そのwork itemの文書へ直接移る。一度だけ動かし(依存は空)、以後は
  // 利用者の選択に任せる。`setSelected`は安定したsetterなので、
  // 依存の配列が空でも抑制の指定は要らない。
  useEffect(() => {
    const link = parseDeepLink(collectDeepLinkCandidates());
    if (link !== null) {
      setSelected({ workItemId: link.work_item_id, attempt: link.attempt });
    }
  }, []);

  function selectRow(row: RequirementsIndexRow): void {
    setSelected({ workItemId: row.work_item_id, attempt: null });
  }

  return (
    <div className="tab requirements-tab">
      <div className="inbox-list">
        <div className="tab-toolbar">
          <h2>要件定義</h2>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={reload}
            disabled={loading}
            aria-label="要件定義一覧を更新"
          >
            更新
          </button>
        </div>
        <div className="filter-row">
          <label className="field-inline">
            work_item_id で絞り込む
            <input
              type="number"
              min={1}
              placeholder="空欄で全件"
              value={workItemIdFilter}
              onChange={(event) => setWorkItemIdFilter(event.target.value)}
            />
          </label>
        </div>
        {loading && <Skeleton />}
        {error !== null && <p className="error-banner">{error}</p>}
        {!loading && rows.length === 0 && error === null && (
          <div className="empty-state">
            <p className="empty-state-title">要件定義はまだありません。</p>
          </div>
        )}
        {!loading && rows.length > 0 && filteredRows.length === 0 && (
          <div className="empty-state">
            <p className="empty-state-title">
              指定した work_item_id の要件定義はありません。
            </p>
          </div>
        )}
        <ul className="inbox-items">
          {filteredRows.map((row) => (
            <li key={row.work_item_id}>
              <button
                type="button"
                className={
                  selected?.workItemId === row.work_item_id ? "selected" : ""
                }
                onClick={() => selectRow(row)}
              >
                <div className="inbox-item-title">
                  {row.title ?? `#${row.issue_number ?? "-"}`}
                </div>
                <div className="inbox-item-meta">
                  {row.owner}/{row.repo}#{row.issue_number ?? "-"} ・{" "}
                  {row.status} ・ attempt {row.latest_attempt} ・ work_item_id{" "}
                  {row.work_item_id}
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
              左の一覧から work item を選択してください。
            </p>
          </div>
        ) : (
          <RequirementsDetail
            key={selected.workItemId}
            workItemId={selected.workItemId}
            attempt={selected.attempt}
            onAttemptChange={(attempt) =>
              setSelected({ workItemId: selected.workItemId, attempt })
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * work item1件の詳細欄。`attempt`(`null`なら最新)の`requirements_doc`を
 * 取得し、過去のattemptに切り替える番号の入力欄を出す。
 * 一覧は最新のattemptしか持たず、問い合わせ直さないと過去のattemptを
 * 列挙できないため、番号で指定させる。
 */
function RequirementsDetail({
  workItemId,
  attempt,
  onAttemptChange,
}: {
  workItemId: number;
  attempt: number | null;
  onAttemptChange: (attempt: number | null) => void;
}): React.ReactElement {
  const [attemptInput, setAttemptInput] = useState(
    attempt === null ? "" : String(attempt),
  );

  function applyAttemptInput(): void {
    const parsed = Number(attemptInput);
    onAttemptChange(
      attemptInput.trim().length > 0 && Number.isInteger(parsed) && parsed > 0
        ? parsed
        : null,
    );
  }

  return (
    <RequirementsDocumentLoader
      workItemId={workItemId}
      attempt={attempt}
      headerActions={
        <label className="field-inline">
          attempt を指定して表示(空欄で最新)
          <input
            type="number"
            min={1}
            value={attemptInput}
            onChange={(event) => setAttemptInput(event.target.value)}
            onBlur={applyAttemptInput}
          />
        </label>
      }
    />
  );
}
