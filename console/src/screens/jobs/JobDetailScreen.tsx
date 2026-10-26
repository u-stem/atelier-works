import { FileQuestion } from "lucide-react";
import { useLocation, useParams } from "react-router";
import { currentJob, useJobDetail } from "../../api/jobsQueries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { jobDetailCrumbs } from "../../lib/breadcrumbs.ts";
import { isJobId } from "../../lib/jobLink.ts";
import {
  jobScriptName,
  parseJobsBack,
  relatedWorkItemId,
} from "../../lib/jobsView.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";
import {
  ArgList,
  DetailSection,
  FailureCauses,
  JobOverview,
  OutputSection,
  StepList,
} from "./JobDetailParts.tsx";

function NotFound({ back }: { back: string | null }) {
  return (
    <>
      <PageHeader title="ジョブの詳細">
        <Breadcrumb items={jobDetailCrumbs(back)} />
      </PageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
          <FileQuestion aria-hidden="true" className="size-6" />
        </span>
        <p className="max-w-sm text-small text-muted-foreground">
          ジョブが見つかりません。IDを確かめてください。
        </p>
      </div>
    </>
  );
}

/** 読み込み中の形。概要、引数、ログの順の目安の高さに合わせる。実機で測り直す。 */
const LOADING_SHAPE: LoadingShape = {
  className: "mx-auto w-full max-w-4xl space-y-4 px-4 py-6 md:px-8",
  node: (
    <>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-32 w-full" />
    </>
  ),
};

const FINISHED_STATES: readonly string[] = [
  "success",
  "failure",
  "canceled",
  "skipped",
];

function JobDetail({ id, back }: { id: string; back: string | null }) {
  const { output, status } = useJobDetail(id);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(output));
  const refresh = refreshStatusOf(output);
  const now = useNow();
  const detail = output.data;

  if (detail === undefined || loadingDisplay !== "content") {
    return (
      <>
        <PageHeader title="ジョブの詳細" refresh={refresh}>
          <Breadcrumb items={jobDetailCrumbs(back)} />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody display={loadingDisplay} shape={LOADING_SHAPE} />
        ) : (
          <QueryFailure
            title="ジョブの詳細を取得できませんでした"
            loginHint="上のバナーからログインすると、ジョブの詳細を表示します。"
            error={output.error}
            onRetry={refresh.onRefresh}
          />
        )}
      </>
    );
  }
  if (!detail.found) {
    return <NotFound back={back} />;
  }

  const job =
    currentJob(
      { data: output.data, updatedAt: output.dataUpdatedAt },
      { data: status.data, updatedAt: status.dataUpdatedAt },
    ) ?? detail.job;
  const backState = back === null ? undefined : { jobsBack: back };
  const active = job.state === "running" || job.state === "queued";
  const changed =
    FINISHED_STATES.includes(job.state) &&
    !FINISHED_STATES.includes(detail.job.state);
  const showCauses =
    job.state === "failure" ||
    job.state === "canceled" ||
    !detail.failures.ok ||
    detail.failures.items.length > 0;

  return (
    <>
      <PageHeader
        title={jobScriptName(job.script_path)}
        subtitle={job.id}
        refresh={refresh}
        refreshLabel="ログと結果を含めて更新"
      >
        <Breadcrumb items={jobDetailCrumbs(back)} />
      </PageHeader>
      <div className={SCROLL_BODY_CLASS}>
        {output.isError ? (
          <StaleDataNotice
            isFetching={output.isFetching}
            error={output.error}
            onRetry={refresh.onRefresh}
          />
        ) : null}
        <DetailSection id="job-overview-heading" title="概要">
          {active ? (
            <p className="text-small text-muted-foreground">
              状態は15秒ごとに更新します。ログと結果は、「ログを更新」で読み込み直します。
            </p>
          ) : null}
          {changed ? (
            <p className="text-small text-warning">
              ジョブの状態が変わりました。「ログを更新」で、ログと結果も読み込み直せます。
            </p>
          ) : null}
          <JobOverview
            job={job}
            now={now}
            relatedItemId={relatedWorkItemId(detail.args)}
            back={backState}
          />
        </DetailSection>
        {showCauses ? (
          <DetailSection id="job-failures-heading" title="失敗の原因(保存済み)">
            <FailureCauses
              failures={detail.failures}
              now={now}
              back={backState}
            />
          </DetailSection>
        ) : null}
        {detail.steps.length === 0 ? null : (
          <DetailSection id="job-steps-heading" title="ステップ">
            <StepList steps={detail.steps} back={backState} />
          </DetailSection>
        )}
        <DetailSection id="job-args-heading" title="引数">
          <ArgList args={detail.args} />
        </DetailSection>
        <OutputSection
          id="job-result-heading"
          title="結果"
          kind="result"
          output={detail.result}
          error={detail.result_error}
          emptyText="結果はありません。"
        />
        <OutputSection
          id="job-log-heading"
          title="ログ"
          kind="log"
          output={detail.log}
          error={null}
          emptyText="ログはありません。"
          onRefresh={() => {
            void output.refetch();
          }}
          refreshLabel="ログを更新"
          refreshing={output.isFetching}
        />
      </div>
    </>
  );
}

/**
 * ジョブの詳細の画面。状態、script、時刻、引数、結果、ログ、フローのステップ、関連する作業項目、失敗の原因を出す。
 * IDがUUIDの形でないときと、サーバーが見つからないと返したときは、同じ「見つかりません」を出す。存在を区別しないためである。
 * ログ、結果、引数、原因は、テキストのノードとしてだけ描く。
 * 実行中か待ちのジョブは、状態だけを15秒ごとに取り直す。ログは「ログを更新」の操作で取り直す。
 */
export function JobDetailScreen() {
  const params = useParams();
  // 一覧の行から開いたときは、一覧のタブと絞り込みを持った戻り先が履歴の`state`に入っている。
  const back = parseJobsBack(useLocation().state);
  const id = params.id;
  if (!isJobId(id)) {
    return <NotFound back={back} />;
  }
  const normalized = id.toLowerCase();
  return <JobDetail key={normalized} id={normalized} back={back} />;
}
