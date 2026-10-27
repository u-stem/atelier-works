// 作業項目の詳細で、動いているflowのジョブの詳細を読む取得。
// 読むのは作業項目の`flow_job_id`が指すジョブ1件で、ログと結果は含めない。
// 概要のタブを選んでいて、画面が操作されていて、文書が見えている間だけ、ジョブが実行中か待ちのあいだ15秒ごとに取る。
// 作業項目の状態では止めない。承認待ちのようにflowが終わった状態でも、ジョブの状態で決める。
// ジョブが終わったら、作業項目の詳細を1回だけ取り直し、引き継ぎ先の新しい`flow_job_id`に追従する。
// 承認や再実行でflowが引き継がれたときは追従しない。更新の操作で取り直す。

import {
  type QueryClient,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { refreshStatusOfAll } from "../app/refreshStatus.ts";
import { useIdle } from "../lib/idleTracker.ts";
import type { ItemDetailTabId } from "../lib/itemDetailView.ts";
import { isFinishedJobState } from "../lib/jobsView.ts";
import {
  createFinishReloadWatcher,
  type FlowProgressView,
  flowJobTarget,
  flowProgressOf,
} from "../lib/workItemFlowProgress.ts";
import type { WorkItemDetail } from "./guards/workItemDetail.ts";
import {
  JOB_DETAIL_REFRESH_MS,
  type JobDetailView,
  jobDetailQueryOptions,
} from "./jobsQueries.ts";
import { workItemDetailQueryKey } from "./workItemDetailQueries.ts";

/** 終わったジョブの詳細か。終わったジョブの詳細は、もう変わらない。 */
function isFinishedDetail(data: JobDetailView | undefined): boolean {
  return data !== undefined && data.found && isFinishedJobState(data.job.state);
}

/**
 * flowのジョブの詳細の取得の設定。ジョブ詳細の画面が状態だけを読む取得とキーを共有する。
 * ジョブが実行中か待ちのあいだ15秒ごとに取り直し、文書が見えない間とフォーカスの出入りでは取り直さない。
 * 終わったジョブは古くならない。概要を開き直すたびに取り直して、Windmillのジョブを増やさないためである。
 */
export function flowJobQueryOptions(jobId: string | null, enabled: boolean) {
  return {
    ...jobDetailQueryOptions(jobId ?? "", { includeOutput: false }),
    enabled: enabled && jobId !== null,
    staleTime: (query: {
      readonly state: { readonly data: JobDetailView | undefined };
    }): number =>
      isFinishedDetail(query.state.data)
        ? Number.POSITIVE_INFINITY
        : JOB_DETAIL_REFRESH_MS,
  };
}

/**
 * 作業項目の詳細を、購読のあるものだけ1回取り直す。
 * 画面に出していない詳細は、古いと印を付けるだけで、走らせない。
 */
export async function reloadWorkItem(
  client: QueryClient,
  workItemId: number,
): Promise<void> {
  await client.invalidateQueries({
    queryKey: workItemDetailQueryKey(workItemId),
    refetchType: "active",
  });
}

/**
 * ジョブの詳細を読むたびに呼ぶ。実行中か待ちから終了へ変わったと`watch`が知らせたときだけ、
 * 作業項目の詳細を1回取り直す。flowが次のflowへ引き継いだときの、新しい`flow_job_id`に追従するためである。
 */
export async function followFinish(
  client: QueryClient,
  watch: (jobId: string, detail: JobDetailView | undefined) => boolean,
  workItemId: number,
  jobId: string | null,
  detail: JobDetailView | undefined,
): Promise<void> {
  if (jobId === null || !watch(jobId, detail)) return;
  await reloadWorkItem(client, workItemId);
}

/**
 * 更新の操作で、作業項目の詳細を取ってから、そのflowのジョブの詳細を取る。
 * 2つの取得がConsole用workerの枠を取り合わないためである。
 * ジョブは、取り直した作業項目の`flow_job_id`で読む。引き継ぎで変わった後に、古いジョブを読まないためである。
 */
export async function refreshItemThenJob(reads: {
  readonly item: () => Promise<WorkItemDetail | null | undefined>;
  readonly job: (flowJobId: string | null) => Promise<unknown>;
}): Promise<void> {
  const item = await reads.item();
  await reads.job(item?.work_item.flow_job_id ?? null);
}

/** ジョブの詳細を、いまの値に取り直す。読めなければ何もしない。失敗は投げない。 */
async function refetchFlowJob(
  client: QueryClient,
  flowJobId: string | null,
): Promise<void> {
  if (flowJobId === null) return;
  await client
    .fetchQuery({ ...flowJobQueryOptions(flowJobId, true), staleTime: 0 })
    .then(
      () => undefined,
      () => undefined,
    );
}

type RefreshQueries = Parameters<typeof refreshStatusOfAll>[0];

/**
 * 見出しの更新に渡す取得。作業項目、ジョブの順に取り、最終更新は古い方の時刻になる。
 * ジョブの詳細を画面に出していないとき(`showsJob`が偽)は、読まず、時刻と取得中にも数えない。
 * 出さないジョブの詳細を読むと、Windmillのジョブが増え、最終更新に古い時刻が混ざるためである。
 * ジョブの取得の失敗は、進行の節が前の値として伝える。見出しの失敗には数えない。
 */
export function itemRefreshQueries(input: {
  readonly item: {
    readonly dataUpdatedAt: number;
    readonly isFetching: boolean;
    readonly isError: boolean;
    readonly error: unknown;
  };
  readonly job: {
    readonly dataUpdatedAt: number;
    readonly isFetching: boolean;
  };
  readonly showsJob: boolean;
  readonly refetchItem: () => Promise<WorkItemDetail | null | undefined>;
  readonly refetchJob: (flowJobId: string | null) => Promise<unknown>;
}): RefreshQueries {
  const itemQuery = {
    dataUpdatedAt: input.item.dataUpdatedAt,
    isFetching: input.item.isFetching,
    isError: input.item.isError,
    error: input.item.error,
    refetch: () =>
      refreshItemThenJob({
        item: input.refetchItem,
        job: input.showsJob ? input.refetchJob : () => Promise.resolve(),
      }),
  };
  if (!input.showsJob) return [itemQuery];
  return [
    itemQuery,
    {
      dataUpdatedAt: input.job.dataUpdatedAt,
      isFetching: input.job.isFetching,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
    },
  ];
}

export type WorkItemFlow = {
  readonly view: FlowProgressView;
  /** 見出しの更新に渡す取得。 */
  readonly refreshQueries: RefreshQueries;
};

/**
 * 作業項目を進めているflowの進行を読む。
 * 概要のタブを選んでいて、画面が操作されているときだけ読む。
 * ジョブが終わったと分かったら、作業項目の詳細を1回だけ取り直す。
 */
export function useWorkItemFlow(input: {
  readonly workItemId: number;
  readonly item: UseQueryResult<WorkItemDetail | null, Error>;
  readonly tab: ItemDetailTabId;
}): WorkItemFlow {
  const { workItemId, item, tab } = input;
  const client = useQueryClient();
  const idle = useIdle();
  const overview = item.data?.work_item;
  const target =
    overview === undefined
      ? { jobId: null, enabled: false }
      : flowJobTarget(overview, { tab, idle });
  const job = useQuery(flowJobQueryOptions(target.jobId, target.enabled));

  // 監視は状態を持つ。描画のたびに作り直さないよう、最初の描画で1つだけ作る。
  const [watch] = useState(() => createFinishReloadWatcher());
  useEffect(() => {
    void followFinish(client, watch, workItemId, target.jobId, job.data);
  }, [client, watch, workItemId, target.jobId, job.data]);

  const refetchItem = item.refetch;
  const refetchJob = useCallback(
    (flowJobId: string | null) => refetchFlowJob(client, flowJobId),
    [client],
  );

  return {
    view: flowProgressOf({
      jobId: target.jobId,
      detail: job.data,
      failed: job.isError,
    }),
    refreshQueries: itemRefreshQueries({
      item,
      job: {
        dataUpdatedAt: target.jobId === null ? 0 : job.dataUpdatedAt,
        isFetching: job.isFetching,
      },
      showsJob: tab === "overview",
      refetchItem: () => refetchItem().then((result) => result.data),
      refetchJob,
    }),
  };
}
