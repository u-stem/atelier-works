import { ArrowLeft, FileQuestion } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";
import { useWorkItemDetail } from "../../api/workItemDetailQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import {
  describeOverview,
  type ItemDetailTabId,
  parseDetailTab,
} from "../../lib/itemDetailView.ts";
import { workItemRef } from "../../lib/labels.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { ApprovalsTab } from "./detail/ApprovalsTab.tsx";
import {
  ITEM_DETAIL_PANEL_ID,
  ItemDetailTabs,
  panelLabelledBy,
} from "./detail/ItemDetailTabs.tsx";
import { OverviewTab } from "./detail/OverviewTab.tsx";
import { RequirementsTab } from "./detail/RequirementsTab.tsx";
import { RoundsTab } from "./detail/RoundsTab.tsx";
import { QueryFailure } from "./QueryFailure.tsx";

function BackLink() {
  return (
    <Link
      to="/items"
      className="mt-1 inline-flex items-center gap-1 rounded-sm text-small text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      作業項目の一覧
    </Link>
  );
}

function Message({ children }: { children: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
        <FileQuestion aria-hidden="true" className="size-6" />
      </span>
      <p className="max-w-sm text-small text-muted-foreground">{children}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="mx-auto w-full max-w-[75rem] space-y-4 px-4 py-6 md:px-8"
      role="status"
    >
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-40 w-full max-w-[47.5rem] rounded-xl" />
      <Skeleton className="h-5 w-2/3 max-w-[47.5rem]" />
      <Skeleton className="h-32 w-full max-w-[47.5rem]" />
    </div>
  );
}

function ItemDetail({ workItemId }: { workItemId: number }) {
  const query = useWorkItemDetail(workItemId);
  const refresh = refreshStatusOf(query);
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseDetailTab(searchParams.get("tab"));
  const detail = query.data;

  const selectTab = (id: ItemDetailTabId): void => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === "overview") {
          next.delete("tab");
        } else {
          next.set("tab", id);
        }
        return next;
      },
      { replace: true },
    );
  };

  if (detail === undefined) {
    return (
      <>
        <PageHeader title={workItemRef(workItemId)} refresh={refresh}>
          <BackLink />
        </PageHeader>
        {query.isError ? (
          <QueryFailure
            title="作業項目の詳細を取得できませんでした"
            loginHint="上のバナーからログインすると、作業項目の詳細を表示します。"
            error={query.error}
            onRetry={refresh.onRefresh}
          />
        ) : (
          <LoadingState />
        )}
      </>
    );
  }
  if (detail === null) {
    return (
      <>
        <PageHeader title={workItemRef(workItemId)} refresh={refresh}>
          <BackLink />
        </PageHeader>
        <Message>{`${workItemRef(workItemId)}は見つかりませんでした。番号を確かめてください。`}</Message>
      </>
    );
  }

  const overview = describeOverview(detail.work_item);
  return (
    <>
      <PageHeader
        title={overview.title}
        subtitle={`${workItemRef(workItemId)}・${overview.kindLabel}`}
        refresh={refresh}
      >
        <BackLink />
      </PageHeader>
      <ItemDetailTabs selected={tab} onSelect={selectTab} />
      <div
        id={ITEM_DETAIL_PANEL_ID}
        role="tabpanel"
        aria-labelledby={panelLabelledBy(tab)}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8"
      >
        {tab === "overview" ? <OverviewTab detail={detail} now={now} /> : null}
        {tab === "requirements" ? (
          <RequirementsTab detail={detail} now={now} />
        ) : null}
        {tab === "rounds" ? <RoundsTab detail={detail} now={now} /> : null}
        {tab === "approvals" ? (
          <ApprovalsTab detail={detail} now={now} />
        ) : null}
      </div>
    </>
  );
}

/**
 * 作業項目の詳細の画面。概要、要件定義、ラウンド、承認の履歴のタブを持つ。
 * 開くタブはURLの`?tab=`に持つ。読み取り専用で、再実行や承認などの書き込みは要対応の画面で行う。
 * 作業項目の番号が正しくないときは取得せず、存在しない番号のときは「見つかりませんでした」を出す。
 */
export function ItemDetailScreen() {
  const params = useParams();
  const workItemId = parseIdParam(params.id);
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="作業項目">
          <BackLink />
        </PageHeader>
        <Message>作業項目の番号が正しくありません。</Message>
      </>
    );
  }
  return <ItemDetail key={workItemId} workItemId={workItemId} />;
}
