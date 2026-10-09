import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import { useSummary } from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  type InboxSelection,
  parseSelection,
  withSelection,
} from "../../lib/inboxSelection.ts";
import {
  buildInboxItems,
  chipCounts,
  effectiveChip,
  filterInboxItems,
  findInboxItem,
  type InboxChip,
  otherCountsNote,
  selectionAfterFilter,
  sortInboxItems,
  visibleChips,
} from "../../lib/inboxView.ts";
import { InboxDetail } from "./InboxDetail.tsx";
import { InboxList } from "./InboxList.tsx";

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
 * 取得に失敗して表示できるデータが無いときの表示。
 * 401は画面上部のバナーが知らせるので、同じ内容の警告を重ねない。
 */
function FailureState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        ログインすると、要対応の一覧を表示します。
      </p>
    );
  }
  return (
    <div className="p-6">
      <Alert variant="destructive">
        <AlertTitle>要対応の一覧を取得できませんでした</AlertTitle>
        <AlertDescription>
          <p>
            {apiError === null
              ? "原因は不明です。"
              : describeApiError(apiError)}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            もう一度取得する
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * 要対応の画面。項目を新しい順に並べ、種類のチップで絞り込む。
 * 選んだ行は`?approval=<id>`などに持つ(同時に1つだけ)。選択の変更は履歴を積まない。
 * 一覧と詳細は別々にスクロールする。この画面から承認・却下などの操作は起こさない。
 */
export function InboxScreen() {
  const summary = useSummary();
  const now = useNow(CLOCK_TICK_MS);
  const [searchParams, setSearchParams] = useSearchParams();
  const [chip, setChip] = useState<InboxChip>("all");
  const selection = parseSelection(searchParams);
  const refresh = refreshStatusOf(summary);

  const select = (next: InboxSelection | null): void => {
    setSearchParams(withSelection(searchParams, next), { replace: true });
  };

  if (summary.data === undefined) {
    return (
      <>
        <PageHeader title="要対応" refresh={refresh} />
        {summary.isError ? (
          <FailureState error={summary.error} onRetry={refresh.onRefresh} />
        ) : (
          <LoadingState />
        )}
      </>
    );
  }

  const items = sortInboxItems(buildInboxItems(summary.data));
  const activeChip = effectiveChip(items, chip);
  const visible = filterInboxItems(items, activeChip);
  const counts = chipCounts(items);
  const note = otherCountsNote(summary.data.counts, items);
  const hasUnlisted =
    summary.data.counts.failures > 0 || summary.data.counts.notices > 0;

  return (
    <>
      <PageHeader title="要対応" refresh={refresh} />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0">
          <legend className="sr-only">種類で絞り込む</legend>
          {visibleChips(items).map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={activeChip === item.id ? "default" : "outline"}
              aria-pressed={activeChip === item.id}
              onClick={() => {
                setChip(item.id);
                const kept = selectionAfterFilter(selection, item.id);
                if (kept === null && selection !== null) {
                  select(null);
                }
              }}
            >
              {item.label}
              <span className="tabular-nums">{counts[item.id]}</span>
            </Button>
          ))}
        </fieldset>
        {note === null ? null : (
          <p className="text-sm text-muted-foreground">
            {note}
            {hasUnlisted ? "失敗と通知の一覧は準備中です。" : null}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="要対応の一覧"
          className="w-96 shrink-0 overflow-y-auto border-r border-border"
        >
          {visible.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {items.length === 0
                ? "要対応の項目はありません。"
                : "この種類の項目はありません。"}
            </p>
          ) : (
            <InboxList
              items={visible}
              selected={selection}
              now={now}
              onSelect={select}
            />
          )}
        </section>
        <section
          aria-label="選んだ項目の概要"
          className="min-w-0 flex-1 overflow-y-auto"
        >
          <InboxDetail
            item={findInboxItem(items, selection)}
            selection={selection}
            now={now}
          />
        </section>
      </div>
    </>
  );
}
