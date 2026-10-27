import { FileQuestion } from "lucide-react";
import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { useRequirementsDoc, useRequirementsIndex } from "../../api/queries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader, subtitlePendingOf } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { itemRequirementsCrumbs } from "../../lib/breadcrumbs.ts";
import { attemptRef, workItemRef } from "../../lib/labels.ts";
import {
  REQUIREMENTS_FRAME_CLASS,
  REQUIREMENTS_SCROLL_CLASS,
} from "../../lib/layoutClasses.ts";
import {
  confirmedLatestAttempt,
  parseAttemptParam,
  prepareDoc,
} from "../../lib/requirementsView.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { SCROLL_ROOT_PROPS } from "../../lib/scrollRoot.ts";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsDocumentView } from "./RequirementsDocumentView.tsx";

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
 * 読み込み中の形。実物と同じ枠(本文と、右の目次の2列)に、状態の行、要約、本文の塊を置く。
 * 寸法は、実機で実物を描いて測った値で、状態の行(2行に折り返す)は63px。目次は1100px以上の幅で出る。
 * 本文の長さは書類で変わるので、画面の下端を満たす目安にする。
 */
export const REQUIREMENTS_DOC_LOADING_SHAPE: LoadingShape = {
  className: REQUIREMENTS_SCROLL_CLASS,
  node: (
    <div className={REQUIREMENTS_FRAME_CLASS}>
      <div className="flex min-w-0 max-w-[47.5rem] flex-1 flex-col gap-6">
        <Skeleton className="h-[3.9rem] w-full rounded-md" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
      <div className="hidden w-56 shrink-0 min-[1100px]:block">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-36" />
        </div>
      </div>
    </div>
  ),
};

function ItemRequirements({
  workItemId,
  attempt,
}: {
  workItemId: number;
  attempt: number | null;
}) {
  const query = useRequirementsDoc(workItemId, attempt);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(query));
  const index = useRequirementsIndex();
  const refresh = refreshStatusOf(query);
  const doc = query.data;
  const prepared = useMemo(
    () => (doc === undefined || doc === null ? null : prepareDoc(doc)),
    [doc],
  );
  const requested =
    attempt === null
      ? `${workItemRef(workItemId)}の要件定義`
      : `${workItemRef(workItemId)}の要件定義(${attemptRef(attempt)})`;

  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (doc === undefined || loadingDisplay !== "content") {
    return (
      <>
        {/* 副題は取得後に出る。待つ間も副題の行を空け、取得後の見出しと同じ高さにして、下の本文が動かないようにする。 */}
        <PageHeader
          title={requested}
          subtitlePending={subtitlePendingOf(loadingDisplay)}
          refresh={refresh}
        >
          <Breadcrumb items={itemRequirementsCrumbs(workItemId)} />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody
            display={loadingDisplay}
            shape={REQUIREMENTS_DOC_LOADING_SHAPE}
          />
        ) : (
          <QueryFailure
            title="要件定義書を取得できませんでした"
            loginHint="上のバナーからログインすると、要件定義書を表示します。"
            error={query.error}
            onRetry={refresh.onRefresh}
          />
        )}
      </>
    );
  }
  if (doc === null || prepared === null) {
    return (
      <>
        <PageHeader title={requested} refresh={refresh}>
          <Breadcrumb items={itemRequirementsCrumbs(workItemId)} />
        </PageHeader>
        <Message>{`${requested}は見つかりませんでした。`}</Message>
      </>
    );
  }
  const indexRow = index.data?.find((row) => row.work_item_id === workItemId);
  const latestAttempt = confirmedLatestAttempt({
    requested: attempt,
    shown: doc.attempt,
    indexed: indexRow?.latest_attempt ?? null,
  });
  return (
    <>
      <PageHeader
        title={prepared.title}
        subtitle={`${workItemRef(doc.work_item_id)}・${attemptRef(doc.attempt)}`}
        refresh={refresh}
      >
        <Breadcrumb items={itemRequirementsCrumbs(workItemId)} />
      </PageHeader>
      <div {...SCROLL_ROOT_PROPS} className={REQUIREMENTS_SCROLL_CLASS}>
        <RequirementsDocumentView
          doc={doc}
          prepared={prepared}
          latestAttempt={latestAttempt}
        />
      </div>
    </>
  );
}

/**
 * 作業項目の要件定義書の画面。`?attempt=<k>`で試行を指し、無ければ最新の試行を出す。
 * 作業項目の番号か試行の番号が正しくないときは、取得せずにその旨を出す。
 */
export function ItemRequirementsScreen() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const workItemId = parseIdParam(params.id);
  const attemptParam = parseAttemptParam(searchParams.get("attempt"));
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="要件定義">
          <Breadcrumb items={itemRequirementsCrumbs(null)} />
        </PageHeader>
        <Message>作業項目の番号が正しくありません。</Message>
      </>
    );
  }
  if (attemptParam.kind === "invalid") {
    return (
      <>
        <PageHeader title="要件定義">
          <Breadcrumb items={itemRequirementsCrumbs(workItemId)} />
        </PageHeader>
        <Message>試行の番号が正しくありません。</Message>
      </>
    );
  }
  const attempt = attemptParam.kind === "attempt" ? attemptParam.attempt : null;
  return (
    <ItemRequirements
      key={`${workItemId}-${attempt ?? "latest"}`}
      workItemId={workItemId}
      attempt={attempt}
    />
  );
}
