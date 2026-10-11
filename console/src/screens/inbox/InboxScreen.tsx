import { ArrowLeft, LogIn } from "lucide-react";
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
  inboxDetailClass,
  inboxListClass,
  inboxPane,
} from "../../lib/inboxPane.ts";
import {
  type InboxSelection,
  parseSelection,
  withSelection,
} from "../../lib/inboxSelection.ts";
import {
  auditFailureCount,
  buildInboxItems,
  chipCounts,
  effectiveChip,
  filterInboxItems,
  findInboxItem,
  type InboxChip,
  inboxSubtitle,
  selectionAfterFilter,
  sortInboxItems,
  unlistedCounts,
  visibleChips,
} from "../../lib/inboxView.ts";
import { InboxDetail } from "./InboxDetail.tsx";
import { InboxEmpty } from "./InboxEmpty.tsx";
import { InboxList } from "./InboxList.tsx";
import { KindChips } from "./KindChips.tsx";
import { UnlistedCards } from "./UnlistedCards.tsx";

function LoadingState() {
  return (
    <div className="flex min-h-0 flex-1" role="status">
      <span className="sr-only">読み込み中</span>
      <div className="w-full shrink-0 border-border lg:w-80 lg:border-r min-[1280px]:w-[28rem]">
        {["a", "b", "c", "d"].map((key) => (
          <div
            key={key}
            className="flex gap-3 border-b border-border px-6 py-4"
          >
            <Skeleton className="mt-1.5 size-2 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden flex-1 space-y-4 p-8 lg:block">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full max-w-3xl rounded-xl" />
      </div>
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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
          <LogIn aria-hidden="true" className="size-6" />
        </span>
        <p className="text-lead font-semibold">ログインが必要です</p>
        <p className="max-w-sm text-small text-muted-foreground">
          上のバナーからログインすると、要対応の一覧を表示します。
        </p>
      </div>
    );
  }
  return (
    <div className="p-8">
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
 * 一覧が空のときは、画面を割らずに状況の面を出す。
 * 幅が狭いとき(lg未満)は一覧と詳細を1画面ずつ出し、詳細の「一覧へ戻る」で選択を外して一覧へ戻る。
 * 一覧と詳細は別々にスクロールする。一覧の行は選ぶだけで、承認・却下、再実行、通知の解決などの操作は詳細のペインに置く。
 */
export function InboxScreen() {
  const summary = useSummary();
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const [chip, setChip] = useState<InboxChip>("all");
  const selection = parseSelection(searchParams);
  const refresh = refreshStatusOf(summary);
  const items =
    summary.data === undefined
      ? []
      : sortInboxItems(buildInboxItems(summary.data));
  const activeChip = effectiveChip(items, chip);
  if (activeChip !== chip) {
    // 選んだ種類の項目がなくなったら、状態も「すべて」に揃える。
    // 描画だけを戻すと、項目が戻ったときに操作なしで絞り込みへ戻ってしまう。
    setChip(activeChip);
  }

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

  const unlisted = unlistedCounts(
    summary.data.counts,
    items,
    auditFailureCount(summary.data),
  );
  const header = (
    <PageHeader
      title="要対応"
      subtitle={inboxSubtitle(items, unlisted)}
      refresh={refresh}
    />
  );

  if (items.length === 0) {
    return (
      <>
        {header}
        <InboxEmpty
          updatedAt={summary.dataUpdatedAt}
          now={now}
          unlisted={unlisted}
        />
      </>
    );
  }

  const visible = filterInboxItems(items, activeChip);
  const chips = visibleChips(items);
  const pane = inboxPane(selection);

  return (
    <>
      {header}
      {chips.length === 0 && unlisted.length === 0 ? null : (
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3 md:px-8">
          {chips.length === 0 ? (
            <span className="text-small font-medium text-muted-foreground">
              ほかに対応が必要なもの
            </span>
          ) : (
            <KindChips
              chips={chips}
              counts={chipCounts(items)}
              active={activeChip}
              onChange={(next) => {
                setChip(next);
                if (selectionAfterFilter(selection, next) === null) {
                  select(null);
                }
              }}
            />
          )}
          {unlisted.length === 0 ? null : (
            <UnlistedCards entries={unlisted} compact />
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <section aria-label="要対応の一覧" className={inboxListClass(pane)}>
          <InboxList
            items={visible}
            selected={selection}
            now={now}
            onSelect={select}
          />
        </section>
        <section
          aria-label="選んだ項目の概要"
          className={inboxDetailClass(pane)}
        >
          <div className="border-b border-border px-4 py-2 lg:hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                select(null);
              }}
            >
              <ArrowLeft aria-hidden="true" />
              一覧へ戻る
            </Button>
          </div>
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
