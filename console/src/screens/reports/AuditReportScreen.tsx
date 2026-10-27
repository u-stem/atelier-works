import { useParams } from "react-router";
import { useAuditDoc } from "../../api/auditQueries.ts";
import { isBannerError } from "../../api/errors.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { auditProposalTotal, auditReportTitle } from "../../lib/auditView.ts";
import { auditReportCrumbs } from "../../lib/breadcrumbs.ts";
import { workItemRef, workItemStatusLabel } from "../../lib/labels.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { AuditMarkdown } from "./AuditMarkdown.tsx";

/** 読み込み中の形。 */
export const AUDIT_REPORT_LOADING_SHAPE: LoadingShape = {
  className: "space-y-3 px-4 py-6 md:px-8",
  node: (
    <>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-full max-w-3xl" />
      <Skeleton className="h-4 w-4/5 max-w-3xl" />
      <Skeleton className="h-40 w-full max-w-3xl rounded-xl" />
    </>
  ),
};

/** 監査レポートの本文の画面。作業項目の番号の経路で受ける。 */
export function AuditReportScreen() {
  const params = useParams();
  const workItemId = parseIdParam(params.id);
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="監査レポート">
          <Breadcrumb items={auditReportCrumbs(null)} />
        </PageHeader>
        <ComingSoon>作業項目の番号が正しくありません。</ComingSoon>
      </>
    );
  }
  return <AuditReportView workItemId={workItemId} />;
}

function AuditReportView({ workItemId }: { workItemId: number }) {
  const query = useAuditDoc(workItemId);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(query));
  const refresh = refreshStatusOf(query);

  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (query.isPending || loadingDisplay !== "content") {
    return (
      <>
        <PageHeader title={`${workItemRef(workItemId)}の監査レポート`}>
          <Breadcrumb items={auditReportCrumbs(workItemId)} />
        </PageHeader>
        <LoadingBody
          display={loadingDisplay}
          shape={AUDIT_REPORT_LOADING_SHAPE}
        />
      </>
    );
  }

  if (query.isError) {
    const apiError = apiErrorOf(query.error);
    return (
      <>
        <PageHeader
          title={`${workItemRef(workItemId)}の監査レポート`}
          refresh={refresh}
        >
          <Breadcrumb items={auditReportCrumbs(workItemId)} />
        </PageHeader>
        <div className="p-8">
          {apiError !== null && isBannerError(apiError) ? (
            <p className="text-small text-muted-foreground">
              ログインすると、監査レポートを表示します。
            </p>
          ) : (
            <QueryFailureAlert
              title="監査レポートを取得できませんでした"
              error={query.error}
              onRetry={refresh.onRefresh}
            />
          )}
        </div>
      </>
    );
  }

  const doc = query.data;
  if (doc === null) {
    return (
      <>
        <PageHeader
          title={`${workItemRef(workItemId)}の監査レポート`}
          refresh={refresh}
        >
          <Breadcrumb items={auditReportCrumbs(workItemId)} />
        </PageHeader>
        <ComingSoon>
          この作業項目の監査レポートは見つかりません。監査がまだ終わっていないか、監査の作業項目ではありません。
        </ComingSoon>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={auditReportTitle(doc.period_label)}
        subtitle={`${workItemStatusLabel(doc.work_item_status)} ・ ${auditProposalTotal(doc)} ・ ${workItemRef(doc.work_item_id)}`}
        refresh={refresh}
      >
        <Breadcrumb items={auditReportCrumbs(workItemId)} />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <article className="max-w-3xl rounded-xl border border-border bg-card px-4 py-6 text-body md:px-8">
          <AuditMarkdown markdown={doc.markdown} />
        </article>
      </div>
    </>
  );
}
