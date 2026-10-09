import { useState } from "react";
import { useSearchParams } from "react-router";
import { ApiFailure, describeApiError } from "../../api/errors.ts";
import { useSummary } from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { useNow } from "../../app/useNow.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  parseApprovalParam,
  withApprovalParam,
} from "../../lib/inboxSelection.ts";
import {
  chipCounts,
  filterApprovals,
  findApproval,
  INBOX_CHIPS,
  type InboxChip,
  otherCountsNote,
  sortApprovals,
} from "../../lib/inboxView.ts";
import { ApprovalList } from "./ApprovalList.tsx";
import { ApprovalOverview } from "./ApprovalOverview.tsx";

const CLOCK_TICK_MS = 30_000;

function LoadingState() {
  return (
    <div className="flex flex-col gap-3 p-6" role="status">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-16 w-full max-w-2xl" />
      <Skeleton className="h-16 w-full max-w-2xl" />
    </div>
  );
}

/**
 * 要対応の画面。承認待ちを新しい順に並べ、種類のチップで絞り込む。
 * 選んだ行は`?approval=<id>`に持つ。一覧と詳細は別々にスクロールする。
 * この画面から承認・却下などの操作は起こさない。
 */
export function InboxScreen() {
  const summary = useSummary();
  const now = useNow(CLOCK_TICK_MS);
  const [searchParams, setSearchParams] = useSearchParams();
  const [chip, setChip] = useState<InboxChip>("all");
  const selectedId = parseApprovalParam(searchParams);

  if (summary.data === undefined) {
    return (
      <>
        <PageHeader title="要対応" />
        {summary.isError ? (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertTitle>要対応の一覧を取得できませんでした</AlertTitle>
              <AlertDescription>
                <p>
                  {summary.error instanceof ApiFailure
                    ? describeApiError(summary.error.apiError)
                    : "原因は不明です。"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void summary.refetch();
                  }}
                >
                  もう一度取得する
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <LoadingState />
        )}
      </>
    );
  }

  const sorted = sortApprovals(summary.data.approvals);
  const visible = filterApprovals(sorted, chip);
  const counts = chipCounts(sorted);
  const selected = findApproval(sorted, selectedId);
  const note = otherCountsNote(summary.data.counts);

  return (
    <>
      <PageHeader title="要対応" />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0">
          <legend className="sr-only">種類で絞り込む</legend>
          {INBOX_CHIPS.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={chip === item.id ? "default" : "outline"}
              aria-pressed={chip === item.id}
              onClick={() => {
                setChip(item.id);
              }}
            >
              {item.label}
              <span className="tabular-nums">{counts[item.id]}</span>
            </Button>
          ))}
        </fieldset>
        {note === null ? null : (
          <p className="text-sm text-muted-foreground">
            {note}一覧は準備中です。
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="承認待ち"
          className="w-96 shrink-0 overflow-y-auto border-r border-border"
        >
          {visible.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {sorted.length === 0
                ? "承認待ちはありません。"
                : "この種類の承認待ちはありません。"}
            </p>
          ) : (
            <ApprovalList
              approvals={visible}
              selectedId={selectedId}
              now={now}
              onSelect={(id) => {
                setSearchParams(withApprovalParam(searchParams, id));
              }}
            />
          )}
        </section>
        <section
          aria-label="選んだ項目の概要"
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {selected !== null ? (
            <ApprovalOverview approval={selected} now={now} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {selectedId === null
                ? "一覧から項目を選んでください。"
                : "選んだ承認依頼は一覧にありません。すでに処理されたか、まだ取得できていません。"}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
