import { ArrowLeft, FileQuestion } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useRequirementsDoc, useRequirementsIndex } from "../../api/queries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { attemptRef, workItemRef } from "../../lib/labels.ts";
import {
  confirmedLatestAttempt,
  parseAttemptParam,
  prepareDoc,
} from "../../lib/requirementsView.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { SCROLL_ROOT_PROPS } from "../../lib/scrollRoot.ts";
import { QueryFailure } from "./QueryFailure.tsx";
import { RequirementsDocumentView } from "./RequirementsDocumentView.tsx";

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

/** 読み込み中の形。 */
const LOADING_SHAPE: LoadingShape = {
  className: "mx-auto w-full max-w-[75rem] space-y-4 px-8 py-6",
  node: (
    <>
      <Skeleton className="h-8 w-full max-w-[47.5rem] rounded-md" />
      <Skeleton className="h-5 w-2/3 max-w-[47.5rem]" />
      <Skeleton className="h-32 w-full max-w-[47.5rem]" />
    </>
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
        <PageHeader title={requested} refresh={refresh}>
          <BackLink />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody display={loadingDisplay} shape={LOADING_SHAPE} />
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
          <BackLink />
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
        <BackLink />
      </PageHeader>
      <div {...SCROLL_ROOT_PROPS} className="min-h-0 flex-1 overflow-y-auto">
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
          <BackLink />
        </PageHeader>
        <Message>作業項目の番号が正しくありません。</Message>
      </>
    );
  }
  if (attemptParam.kind === "invalid") {
    return (
      <>
        <PageHeader title="要件定義">
          <BackLink />
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
