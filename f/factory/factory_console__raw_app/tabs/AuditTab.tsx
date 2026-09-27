import React, { useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { Skeleton } from "../components/Skeleton";
import { describeError, kickoffAudit, queryConsole } from "../lib/api";
import { isRecord, numOrNull, toRows } from "../lib/coerce";
import { collectDeepLinkCandidates, parseAuditDeepLink } from "../lib/deepLink";
import { type AuditDocRow, toAuditDocRow, toAuditIndexRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

const SKIP_REASONS: Record<string, string> = {
  audit_in_progress: "別の監査が実行中です",
  empty_period: "前回の監査以降の期間がまだありません",
  no_new_records: "前回の監査以降に新しい記録がありません",
  daily_budget_exceeded: "本日の予算を超過しています",
  concurrent_kickoff: "同時に別の監査が起動されました",
};

function describeKickoff(result: unknown): string {
  if (!isRecord(result)) return "起動結果を読み取れませんでした";
  if (result.skipped === true) {
    const reason = typeof result.reason === "string" ? result.reason : "";
    return `スキップしました: ${SKIP_REASONS[reason] ?? reason}`;
  }
  const workItemId = numOrNull(result.work_item_id);
  return workItemId === null
    ? "監査を起動しました"
    : `監査を起動しました(work_item_id ${workItemId})`;
}

export function AuditTab({
  initialWorkItemId,
}: {
  /** A work_item_id to select immediately on mount — set by App.tsx when
   * the Inbox tab's 「レポートを開く」button switches to this tab (see
   * InboxTab.tsx's `onOpenAudit`). `null` when this tab was opened directly
   * (falls back to a `#audit/<id>` deep link, then no selection). */
  initialWorkItemId: number | null;
}): React.ReactElement {
  const { rows, loading, error, reload } = useConsoleQuery(
    "audit_index",
    toAuditIndexRow,
    { limit: 100, days: 3650 },
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [days, setDays] = useState("7");
  const [kickoffMessage, setKickoffMessage] = useState<string | null>(null);
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [kickoffPending, setKickoffPending] = useState(false);

  /** Selects `workItemId` and keeps `location.hash` in sync (`#audit/<id>`)
   * so the URL stays shareable/reloadable — same fragment format
   * lib/deepLink.ts's `parseAuditDeepLink` reads back. Wrapped in try/catch
   * like the rest of this app's `window`/`location` access (see
   * lib/deepLink.ts's module doc): a sandboxed embedding may disallow
   * mutating `location.hash`, and that must not block the selection itself. */
  function selectAudit(workItemId: number): void {
    setSelectedId(workItemId);
    try {
      window.location.hash = `audit/${workItemId}`;
    } catch {
      // Some sandboxed embeddings disallow mutating location.hash.
    }
  }

  // Initial selection priority: `initialWorkItemId` (Inbox tab hand-off)
  // wins over a `#audit/<id>` deep link (Issue comment / Discord
  // notification), neither present leaves the list unselected. Mount-only:
  // App.tsx unmounts this whole tab whenever "audit" isn't the active tab,
  // so `initialWorkItemId` is only ever set once per mount, never changes
  // afterwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only, see comment above.
  useEffect(() => {
    const target =
      initialWorkItemId ??
      parseAuditDeepLink(collectDeepLinkCandidates())?.work_item_id ??
      null;
    if (target !== null) {
      selectAudit(target);
    }
  }, []);

  async function handleKickoff(): Promise<void> {
    setKickoffPending(true);
    setKickoffMessage(null);
    setKickoffError(null);
    try {
      const parsed = Number(days);
      const result = await kickoffAudit(
        rows.length === 0 && Number.isInteger(parsed) && parsed > 0
          ? parsed
          : undefined,
      );
      setKickoffMessage(describeKickoff(result));
      reload();
    } catch (caught) {
      setKickoffError(describeError(caught));
    } finally {
      setKickoffPending(false);
    }
  }

  return (
    <div className="tab audit-tab">
      <div className="inbox-list">
        <div className="tab-toolbar">
          <h2>監査</h2>
          {rows.length === 0 && (
            <label className="field-inline">
              日数
              <input
                type="number"
                min={1}
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void handleKickoff();
            }}
            disabled={kickoffPending}
            aria-label="監査を今すぐ起動"
          >
            今すぐ監査
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={reload}
            disabled={loading}
            aria-label="監査一覧を更新"
          >
            更新
          </button>
        </div>
        {kickoffMessage !== null && (
          <p className="success-banner">{kickoffMessage}</p>
        )}
        {kickoffError !== null && (
          <p className="error-banner">{kickoffError}</p>
        )}
        {loading && <Skeleton />}
        {error !== null && <p className="error-banner">{error}</p>}
        {!loading && rows.length === 0 && error === null && (
          <div className="empty-state">
            <p className="empty-state-title">監査レポートはまだありません。</p>
            <p className="empty-state-hint">
              毎週月曜09:30に自動で実行されます。「今すぐ監査」で前倒しできます。
            </p>
          </div>
        )}
        <ul className="inbox-items">
          {rows.map((row) => (
            <li key={row.audit_report_id}>
              <button
                type="button"
                className={row.work_item_id === selectedId ? "selected" : ""}
                onClick={() => selectAudit(row.work_item_id)}
              >
                <div className="inbox-item-title">監査 {row.period_label}</div>
                <div className="inbox-item-summary">{row.summary}</div>
                <div className="inbox-item-meta">
                  提案: 未決定 {row.pending_count} ・ 承認 {row.approved_count}{" "}
                  ・ 却下 {row.rejected_count} ・ {row.work_item_status} ・
                  work_item_id {row.work_item_id}
                </div>
                <div className="inbox-item-meta">
                  作成: {formatDateTime(row.created_at)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="inbox-detail">
        {selectedId === null ? (
          <div className="empty-state">
            <p className="empty-state-title">
              左の一覧からレポートを選択してください。
            </p>
          </div>
        ) : (
          <AuditDetail key={selectedId} workItemId={selectedId} />
        )}
      </div>
    </div>
  );
}

/** The detail pane for one audit report — fetches "audit_doc" for
 * `workItemId` and owns its own load state. Mounted with `key={selectedId}`
 * by the caller (same pattern as RequirementsTab.tsx's `RequirementsDetail`)
 * so switching the selected report always starts from a clean `doc: null`
 * state instead of momentarily showing the previous report's content while
 * the new one loads. `loading` is tracked separately from `doc === null` so
 * "still fetching" and "fetched, but no such report" render differently —
 * the latter only appears once the fetch has actually resolved with no
 * row. */
function AuditDetail({
  workItemId,
}: {
  workItemId: number;
}): React.ReactElement {
  const [doc, setDoc] = useState<AuditDocRow | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDocError(null);
    setDoc(null);
    queryConsole("audit_doc", 1, 3650, workItemId)
      .then((result) => {
        if (!cancelled) setDoc(toRows(result).map(toAuditDocRow)[0] ?? null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setDocError(describeError(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId]);

  if (loading) {
    return <Skeleton />;
  }
  if (docError !== null) {
    return <p className="error-banner">{docError}</p>;
  }
  if (doc === null) {
    return (
      <p className="empty-state">
        work_item_id {workItemId}の監査レポートが見つかりませんでした。
      </p>
    );
  }
  return (
    <div className="confluence-doc">
      <div className="confluence-doc-header">
        <h1 className="confluence-doc-title">
          監査レポート {doc.period_label}
        </h1>
        <div className="confluence-doc-meta">
          <span>{doc.work_item_status}</span>
          {" ・ "}提案{" "}
          {doc.pending_count + doc.approved_count + doc.rejected_count} 件
          {" ・ "}work_item_id {doc.work_item_id}
        </div>
      </div>
      <div className="confluence-doc-body">
        <div className="confluence-doc-content">
          <Markdown markdown={doc.markdown} />
        </div>
      </div>
    </div>
  );
}
