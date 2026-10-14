import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router";
import { useAuditDoc } from "../../api/auditQueries.ts";
import { isBannerError } from "../../api/errors.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { ComingSoon } from "../../components/ComingSoon.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { auditProposalTotal, auditReportTitle } from "../../lib/auditView.ts";
import { workItemRef, workItemStatusLabel } from "../../lib/labels.ts";
import { apiErrorOf } from "../../lib/queryFailureView.ts";
import { parseIdParam } from "../../lib/routeParams.ts";
import { AuditMarkdown } from "./AuditMarkdown.tsx";

function BackToList() {
  return (
    <Link
      to="/reports"
      className="mt-1 inline-flex items-center gap-1 rounded-sm text-small text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      レポートの一覧へ
    </Link>
  );
}

function Loading() {
  return (
    <div className="space-y-3 px-4 py-6 md:px-8" role="status">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-full max-w-3xl" />
      <Skeleton className="h-4 w-4/5 max-w-3xl" />
      <Skeleton className="h-40 w-full max-w-3xl rounded-xl" />
    </div>
  );
}

/** 監査レポートの本文の画面。作業項目の番号の経路で受ける。 */
export function AuditReportScreen() {
  const params = useParams();
  const workItemId = parseIdParam(params.id);
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="監査レポート">
          <BackToList />
        </PageHeader>
        <ComingSoon>作業項目の番号が正しくありません。</ComingSoon>
      </>
    );
  }
  return <AuditReportView workItemId={workItemId} />;
}

function AuditReportView({ workItemId }: { workItemId: number }) {
  const query = useAuditDoc(workItemId);
  const refresh = refreshStatusOf(query);

  if (query.isPending) {
    return (
      <>
        <PageHeader title={`${workItemRef(workItemId)}の監査レポート`}>
          <BackToList />
        </PageHeader>
        <Loading />
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
          <BackToList />
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
          <BackToList />
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
        <BackToList />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <article className="max-w-3xl rounded-xl border border-border bg-card px-4 py-6 text-body md:px-8">
          <AuditMarkdown markdown={doc.markdown} />
        </article>
      </div>
    </>
  );
}
