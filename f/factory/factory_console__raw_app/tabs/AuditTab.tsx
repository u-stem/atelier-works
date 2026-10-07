import React, { useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { Skeleton } from "../components/Skeleton";
import { describeError, kickoffAudit, queryConsole } from "../lib/api";
import { describeKickoff } from "../lib/auditKickoff";
import { toRows } from "../lib/coerce";
import { collectDeepLinkCandidates, parseAuditDeepLink } from "../lib/deepLink";
import { statusLabel } from "../lib/statusLabel";
import { type AuditDocRow, toAuditDocRow, toAuditIndexRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

export function AuditTab({
  initialWorkItemId,
  onInitialWorkItemConsumed,
}: {
  /**
   * マウント直後に選ぶ`work_item_id`。承認タブの「レポートを開く」ボタンで
   * このタブに切り替えたとき、`App.tsx`が設定する(`InboxTab.tsx`の
   * `onOpenAudit`を参照)。このタブを直接開いたときは`null`で、
   * `#audit/<id>`のディープリンクがあればそれを、無ければ何も選ばない。
   */
  initialWorkItemId: number | null;
  /**
   * 上の受け渡しを反映した後に呼び、`App.tsx`に値を消させる。
   * このタブはタブを切り替えるたびにアンマウントされるので、古い値が残ると
   * 次のマウントで同じレポートを選び直し、その間に利用者が手で選んだ
   * レポートを上書きしてしまう。
   */
  onInitialWorkItemConsumed: () => void;
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

  /**
   * `workItemId`を選び、`location.hash`(`#audit/<id>`)を合わせる。
   * URLを共有・再読み込みできるようにするためで、形式は`lib/deepLink.ts`の
   * `parseAuditDeepLink`が読むものと同じ。このアプリの他の`window`・`location`の
   * 操作と同じくtry/catchで包む。sandbox化された埋め込みでは
   * `location.hash`を変えられないことがあり、それで選択まで止めないため。
   */
  function selectAudit(workItemId: number): void {
    setSelectedId(workItemId);
    try {
      window.location.hash = `audit/${workItemId}`;
    } catch {
      // sandbox化された埋め込みでは`location.hash`を変えられないことがある。
    }
  }

  // 最初の選択は、承認タブからの`initialWorkItemId`を優先し、次に
  // `#audit/<id>`のディープリンク(Issueのコメント・Discordの通知から)を使う。
  // どちらも無ければ何も選ばない。マウント時だけ動かす。`App.tsx`は
  // "audit"が表示中でないときこのタブごとアンマウントするので、
  // `initialWorkItemId`はマウントごとに一度だけ設定され、後から変わらない。
  // 受け渡しは反映の直後に消費する(`App.tsx`で消す)ので、再マウント時は
  // ディープリンクに戻る。ディープリンクは`selectAudit`が利用者の選択に合わせて更新する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: マウント時だけ動かすため。理由は上のコメントを参照。
  useEffect(() => {
    if (initialWorkItemId !== null) {
      selectAudit(initialWorkItemId);
      onInitialWorkItemConsumed();
      return;
    }
    const target =
      parseAuditDeepLink(collectDeepLinkCandidates())?.work_item_id ?? null;
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
                  ・ 却下 {row.rejected_count} ・{" "}
                  {statusLabel(row.work_item_status)} ・ work_item_id{" "}
                  {row.work_item_id}
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

/**
 * 監査レポート1件の詳細欄。`workItemId`の`audit_doc`を取得し、読み込みの
 * 状態を自分で持つ。呼び出し側は`key={selectedId}`を付けてマウントする
 * (`RequirementsTab.tsx`の`RequirementsDetail`と同じ)。レポートを切り替えたとき、
 * 読み込み中に前のレポートが一瞬見えないよう、必ず`doc: null`から始めるため。
 * `loading`は`doc === null`と分けて持ち、「取得中」と「取得したが
 * レポートが無い」を描き分ける。後者は、取得が行無しで終わった後にだけ出る。
 */
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
  const proposalTotal =
    doc.pending_count + doc.approved_count + doc.rejected_count;
  return (
    <div className="confluence-doc">
      <div className="confluence-doc-header">
        <h1 className="confluence-doc-title">
          監査レポート {doc.period_label}
        </h1>
        <div className="confluence-doc-meta">
          <span>{statusLabel(doc.work_item_status)}</span>
          {" ・ "}
          {`提案${proposalTotal}件(承認待ち${doc.pending_count}・承認${doc.approved_count}・却下${doc.rejected_count})`}
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
