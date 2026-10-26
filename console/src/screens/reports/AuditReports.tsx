import { useState } from "react";
import { Link } from "react-router";
import { isBannerError } from "../../api/errors.ts";
import type { AuditIndexRow } from "../../api/guards/audit.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  auditIndexSubtitle,
  auditProposalBreakdown,
  auditReportPath,
} from "../../lib/auditView.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import { workItemRef, workItemStatusLabel } from "../../lib/labels.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { KickoffConfirmDialog } from "./KickoffConfirmDialog.tsx";
import { useAuditKickoff } from "./useAuditKickoff.ts";

function AuditRow({ row, now }: { row: AuditIndexRow; now: number }) {
  const summary = displayableIssueText(row.summary).text;
  return (
    <li>
      <Link
        to={auditReportPath(row.work_item_id)}
        className="block px-6 py-3.5 outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-body font-medium text-foreground">
            監査 {row.period_label}
          </span>
          <span className="shrink-0 text-small text-subtle tabular-nums">
            <TimeText iso={row.created_at} now={now} prefix="作成 " />
          </span>
        </span>
        {summary === "" ? null : (
          <span className="mt-1 line-clamp-2 block text-small break-words text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="mt-1 block text-caption text-subtle">
          {auditProposalBreakdown(row)} ・{" "}
          {workItemStatusLabel(row.work_item_status)} ・{" "}
          {workItemRef(row.work_item_id)}
        </span>
      </Link>
    </li>
  );
}

/** 読み込み中の形。 */
const LOADING_SHAPE: LoadingShape = {
  className: "space-y-2 px-6 py-4",
  node: (
    <>
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-3 w-4/5" />
    </>
  ),
};

/**
 * 一覧の本体。取得中、失敗、空、行ありを出し分ける。
 * 前回の一覧があるときは、取り直しに失敗しても一覧を出したまま、古いことを先頭に添える。
 */
export function AuditListState({
  query,
  now,
}: {
  query: SectionQuery<AuditIndexRow[]>;
  now: number;
}) {
  const display = useLoadingDisplay(loadPhaseOf(query));
  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (display !== "content") {
    return <LoadingBody display={display} shape={LOADING_SHAPE} />;
  }
  const rows = query.data;
  if (rows === undefined) {
    const apiError = apiErrorOf(query.error);
    // 401は画面上部のバナーが知らせるので、同じ内容を重ねない。
    if (apiError !== null && isBannerError(apiError)) {
      return (
        <p className="px-6 py-4 text-small text-muted-foreground">
          ログインすると、監査レポートの一覧を表示します。
        </p>
      );
    }
    return (
      <div className="px-6 py-4">
        <QueryFailureAlert
          title="監査レポートの一覧を取得できませんでした"
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }
  return (
    <>
      {query.isError ? (
        <div className="px-6 py-4">
          <StaleDataNotice
            error={query.error}
            isFetching={query.isFetching}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="flex flex-col gap-1 px-6 py-8 text-center">
          <p className="text-body font-medium">
            監査レポートはまだありません。
          </p>
          <p className="text-small text-muted-foreground">
            毎週月曜09:30に自動で実行されます。「今すぐ監査」で前倒しできます。
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <AuditRow key={row.audit_report_id} row={row} now={now} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 監査レポートの一覧と、監査の手動起動。
 * 行を選ぶと、本文の画面へ移る。
 * 「今すぐ監査」は確認を経て起動し、結果(起動、見送りの理由、失敗)を一覧の上に残す。
 * 起動の後は一覧を読み直す。
 * 一覧の取得は画面が持ち、更新ボタンも画面の見出しにある。この区画は失敗したときの「もう一度取得する」だけを持つ。
 */
export function AuditReports({
  query,
}: {
  query: SectionQuery<AuditIndexRow[]>;
}) {
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const kickoff = useAuditKickoff();
  const rowCount = query.data?.length ?? 0;

  return (
    <section
      aria-labelledby="audit-reports-heading"
      className="rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div>
          <h2 id="audit-reports-heading" className="sr-only">
            監査
          </h2>
          <p className="text-small text-muted-foreground tabular-nums">
            {query.data === undefined ? "" : auditIndexSubtitle(rowCount)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={kickoff.locked}
            onClick={() => {
              setConfirming(true);
            }}
          >
            今すぐ監査
          </Button>
        </div>
      </header>
      {kickoff.notice === null ? null : (
        <div className="border-b border-border px-6 py-3">
          <Alert
            variant={
              kickoff.notice.tone === "error"
                ? "destructive"
                : kickoff.notice.tone === "warning"
                  ? "warning"
                  : "default"
            }
          >
            <AlertDescription>
              <p>{kickoff.notice.message}</p>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <AuditListState query={query} now={now} />
      <KickoffConfirmDialog
        open={confirming}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          kickoff.start();
        }}
      />
    </section>
  );
}
