import { FileQuestion } from "lucide-react";
import { useLocation, useParams } from "react-router";
import {
  currentJob,
  currentSteps,
  failedDetailReads,
  useJobDetail,
} from "../../api/jobsQueries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import {
  refreshStatusOf,
  refreshStatusOfAll,
} from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import { Breadcrumb } from "../../components/Breadcrumb.tsx";
import {
  LoadingBody,
  type LoadingShape,
  SkeletonSection,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { jobDetailCrumbs } from "../../lib/breadcrumbs.ts";
import { isJobId } from "../../lib/jobLink.ts";
import {
  causesPending,
  isActiveJobState,
  isFinishedJobState,
  JOB_RETENTION_DAYS,
  jobScriptName,
  parseJobsBack,
  relatedWorkItemId,
} from "../../lib/jobsView.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import { safeText } from "../../lib/safeText.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";
import { JobActions } from "./JobActions.tsx";
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
          {`ジョブが見つかりません。保持期間(${JOB_RETENTION_DAYS}日)を過ぎたか、IDが違います。`}
        </p>
      </div>
    </>
  );
}

/**
 * 読み込み中の形。実物と同じ本文の枠(左寄せ、節の間40px)に、概要、ステップ、引数、結果、ログの節を並べる。
 * 寸法は、実機で実物を描いて測った値で、節の本文は概要が238px、ステップが91px、引数が100px、結果が80px。
 * ログの高さは出力の量で変わるので、画面の下端を満たす目安にする。
 */
export const JOB_DETAIL_LOADING_SHAPE: LoadingShape = {
  className: SCROLL_BODY_CLASS,
  node: (
    <>
      <SkeletonSection block="h-[14.9rem]" className="max-w-4xl" />
      <SkeletonSection block="h-[5.7rem]" className="max-w-4xl" />
      <SkeletonSection block="h-[6.3rem]" className="max-w-4xl" />
      <SkeletonSection block="h-20" className="max-w-4xl" />
      <SkeletonSection block="h-64" className="max-w-4xl" />
    </>
  ),
};

function JobDetail({ id, back }: { id: string; back: string | null }) {
  const { output, status } = useJobDetail(id);
  const loadingDisplay = useLoadingDisplay(loadPhaseOf(output));
  // 見出しの更新は状態の取得を取り直す。ログと結果は、ログの節の操作でだけ取り直す。
  // 最終更新は、表示している状態を読んだ時刻で、ログと結果の取得の時刻が古くても新しい方を出す。
  const refresh = refreshStatusOfAll([
    {
      dataUpdatedAt: Math.max(output.dataUpdatedAt, status.dataUpdatedAt),
      isFetching: output.isFetching || status.isFetching,
      isError: output.isError || status.isError,
      error: status.isError ? status.error : output.error,
      refetch: () => status.refetch(),
    },
  ]);
  const now = useNow();
  const detail = output.data;

  if (detail === undefined || loadingDisplay !== "content") {
    return (
      <>
        {/* 副題のIDは経路から分かるので、取得を待つ間も出す。取得後の見出しと同じ高さになり、下の本文が動かない。 */}
        <PageHeader
          title="ジョブの詳細"
          subtitle={safeText(id)}
          subtitleMono
          refresh={refreshStatusOf(output)}
        >
          <Breadcrumb items={jobDetailCrumbs(back)} />
        </PageHeader>
        {loadingDisplay !== "content" ? (
          <LoadingBody
            display={loadingDisplay}
            shape={JOB_DETAIL_LOADING_SHAPE}
          />
        ) : (
          <QueryFailure
            title="ジョブの詳細を取得できませんでした"
            loginHint="上のバナーからログインすると、ジョブの詳細を表示します。"
            error={output.error}
            onRetry={() => {
              void output.refetch();
            }}
          />
        )}
      </>
    );
  }
  if (!detail.found) {
    return <NotFound back={back} />;
  }

  const outputRead = { data: output.data, updatedAt: output.dataUpdatedAt };
  const statusRead = { data: status.data, updatedAt: status.dataUpdatedAt };
  const job = currentJob(outputRead, statusRead) ?? detail.job;
  // ステップは、状態の取得も持つ。実行中のフローの進み具合を、15秒ごとの取得で更新する。
  const steps = currentSteps(outputRead, statusRead);
  const backState = back === null ? undefined : { jobsBack: back };
  const active = isActiveJobState(job.state);
  // 取得の後でジョブが終わったとき、保存された原因と結果は、まだ読めていない。
  const changed =
    isFinishedJobState(job.state) && !isFinishedJobState(detail.job.state);
  // 失敗した取得だけを、1つずつ取り直す。2つを同時に走らせない。
  const retryFailedReads = async (): Promise<void> => {
    for (const read of failedDetailReads(output.isError, status.isError)) {
      await (read === "output" ? output.refetch() : status.refetch());
    }
  };
  const showCauses =
    job.state === "failure" ||
    job.state === "canceled" ||
    !detail.failures.ok ||
    detail.failures.items.length > 0;

  return (
    <>
      <PageHeader
        title={safeText(jobScriptName(job.script_path))}
        subtitle={safeText(job.id)}
        subtitleMono
        refresh={refresh}
        refreshLabel="状態を更新"
      >
        <Breadcrumb items={jobDetailCrumbs(back)} />
      </PageHeader>
      <div className={SCROLL_BODY_CLASS}>
        {refresh.isError ? (
          <StaleDataNotice
            isFetching={refresh.isFetching}
            error={status.isError ? status.error : output.error}
            onRetry={() => {
              void retryFailedReads();
            }}
          />
        ) : null}
        <DetailSection
          id="job-overview-heading"
          title="概要"
          actions={
            <JobActions job={job} workItemId={relatedWorkItemId(detail.args)} />
          }
        >
          {active ? (
            <p className="text-small text-muted-foreground">
              状態は15秒ごとに更新します。ログと原因は、「ログと原因を更新」で読み込み直します。
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
              unread={changed}
              maybePending={causesPending(job.completed_at, now)}
            />
          </DetailSection>
        ) : null}
        {steps.length === 0 ? null : (
          <DetailSection id="job-steps-heading" title="ステップ">
            <StepList steps={steps} back={backState} />
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
          unread={changed}
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
          refreshLabel="ログと原因を更新"
          refreshing={output.isFetching || status.isFetching}
        />
      </div>
    </>
  );
}

/**
 * ジョブの詳細の画面。状態、script、時刻、引数、結果、ログ、フローのステップ、関連する作業項目、失敗の原因を出す。
 * IDがUUIDの形でないときと、サーバーが見つからないと返したときは、同じ「見つかりません」を出す。存在を区別しないためである。
 * ログ、結果、引数、原因は、テキストのノードとしてだけ描く。
 * 実行中か待ちのジョブは、状態だけを15秒ごとに取り直す。予定のジョブは自動では取り直さない。
 * ログと保存済みの原因は「ログと原因を更新」の操作で取り直す。
 * 終わっていなかったジョブが終わったと分かったときは、ログと結果を1回だけ自動で取り直す。
 * 取り直すまでは、保存された原因と結果を「まだ読んでいません」と伝える。無いとは言わない。
 * 2つの取得は重ねない。どちらかの取得中は、ログと原因の更新を押せなくする。
 * 終了の直後は、保存済みの原因が検知の間隔の分だけ遅れて書かれるので、無いとは言い切らない。
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
