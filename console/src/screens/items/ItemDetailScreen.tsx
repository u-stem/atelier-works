import { FileQuestion } from "lucide-react";
import { useLocation, useParams, useSearchParams } from "react-router";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { useWorkItemDetail } from "../../api/workItemDetailQueries.ts";
import { useWorkItemFlow } from "../../api/workItemFlowQueries.ts";
import { PageHeader, subtitlePendingOf } from "../../app/PageHeader.tsx";
import { refreshStatusOfAll } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import {
  LoadingBody,
  type LoadingShape,
  SkeletonSection,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { itemDetailCrumbs, parseItemsBack } from "../../lib/breadcrumbs.ts";
import {
  describeOverview,
  type ItemDetailTabId,
  parseDetailTab,
} from "../../lib/itemDetailView.ts";
import { workItemRef } from "../../lib/labels.ts";
import {
  DETAIL_PANEL_CLASS,
  OVERVIEW_BODY_CLASS,
} from "../../lib/layoutClasses.ts";
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

/**
 * 読み込み中の形。実物と同じく、タブの帯と、タブの本体(概要の表と、進行の節)を並べる。
 * 寸法は、実機で実物を描いて測った値で、タブの帯は42px、概要の表は489px。
 * 進行の図の高さは図の大きさで変わるので、画面の下端を満たす目安にする。
 */
export const ITEM_DETAIL_LOADING_SHAPE: LoadingShape = {
  className: "flex min-h-0 flex-1 flex-col",
  node: (
    <>
      <div className="flex h-[2.6rem] items-center gap-6 border-b border-border px-4 md:px-8">
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className={DETAIL_PANEL_CLASS}>
        <div className={OVERVIEW_BODY_CLASS}>
          <Skeleton className="h-[30.5rem] w-full shrink-0 rounded-xl" />
          <SkeletonSection block="h-64" />
        </div>
      </div>
    </>
  ),
};

function ItemDetail({ workItemId }: { workItemId: number }) {
  const query = useWorkItemDetail(workItemId);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(query));
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  // 一覧の行から開いたときは、一覧の範囲を持った戻り先が履歴の`state`に入っている。
  const back = parseItemsBack(useLocation().state);
  const tab = parseDetailTab(searchParams.get("tab"));
  const flow = useWorkItemFlow({ workItemId, item: query, tab });
  // 更新は、作業項目の詳細、flowのジョブの順に取る。最終更新は古い方の時刻になる。
  const refresh = refreshStatusOfAll(flow.refreshQueries);
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

  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (detail === undefined || loadingDisplay !== "content") {
    return (
      <>
        {/* 副題は取得後に出る。待つ間も副題の行を空け、取得後の見出しと同じ高さにして、下の本文が動かないようにする。 */}
        <PageHeader
          title={workItemRef(workItemId)}
          subtitlePending={subtitlePendingOf(loadingDisplay)}
          refresh={refresh}
        >
          <Breadcrumb items={itemDetailCrumbs(workItemId, back)} />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody
            display={loadingDisplay}
            shape={ITEM_DETAIL_LOADING_SHAPE}
          />
        ) : (
          <QueryFailure
            title="作業項目の詳細を取得できませんでした"
            loginHint="上のバナーからログインすると、作業項目の詳細を表示します。"
            error={query.error}
            onRetry={refresh.onRefresh}
          />
        )}
      </>
    );
  }
  if (detail === null) {
    return (
      <>
        <PageHeader title={workItemRef(workItemId)} refresh={refresh}>
          <Breadcrumb items={itemDetailCrumbs(workItemId, back)} />
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
        <Breadcrumb items={itemDetailCrumbs(workItemId, back)} />
      </PageHeader>
      <ItemDetailTabs selected={tab} onSelect={selectTab} />
      <div
        id={ITEM_DETAIL_PANEL_ID}
        role="tabpanel"
        aria-labelledby={panelLabelledBy(tab)}
        className={DETAIL_PANEL_CLASS}
      >
        {tab === "overview" ? (
          <OverviewTab detail={detail} now={now} progress={flow.view} />
        ) : null}
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
          <Breadcrumb items={itemDetailCrumbs(null)} />
        </PageHeader>
        <Message>作業項目の番号が正しくありません。</Message>
      </>
    );
  }
  return <ItemDetail key={workItemId} workItemId={workItemId} />;
}
