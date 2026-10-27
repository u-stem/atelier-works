// ジョブ、schedule、設定の読み取りの型、型ガード、取得。
// 型は`f/factory/console_jobs.ts`、`console_schedules.ts`、`console_config.ts`の戻りに合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_jobs_contract.test.ts`が落ちる。
//
// 一覧は、開いたときと更新の操作のときだけ取る。自動の取り直しはしない。
// Console用workerの枠が1つで、ジョブの一覧の取得が承認などの呼び出しを待たせるため。
// 詳細は、ログと結果を含む取得を1回だけ行い、実行中のジョブの状態だけを15秒ごとに取り直す。
// ログと結果は、フォーカスや再接続、画面を開き直したときにも取り直さない。操作と、終了の検知のときだけ取り直す。

import {
  type QueryClient,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { StepDetails } from "../lib/activeSteps.ts";
import type { JobsTabId } from "../lib/jobsTabs.ts";
import { isActiveJobState, isFinishedJobState } from "../lib/jobsView.ts";
import { ApiFailure } from "./errors.ts";
import {
  type Guard,
  isArrayOf,
  isBoolean,
  isInteger,
  isNullable,
  isNullableInteger,
  isNullableString,
  isOneOf,
  isRecord,
  isString,
} from "./guards/primitives.ts";
import { holdsQueryOptions } from "./holdsQueries.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

export type JobSummaryView = {
  readonly id: string;
  readonly state: string;
  readonly script_path: string;
  readonly job_kind: string;
  readonly created_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly scheduled_for: string | null;
  readonly duration_ms: number | null;
  readonly schedule_path: string | null;
  readonly parent_job: string | null;
  readonly tag: string;
  readonly is_flow_step: boolean;
};

export type ArgViewData = {
  readonly key: string;
  readonly type: string;
  readonly value?: string | number | boolean | null;
};

export type StepViewData = {
  readonly id: string;
  readonly state: string;
  readonly job_id: string | null;
  readonly iterations: number | null;
  /** Windmillが条件で飛ばしたステップ。状態は`success`のまま返る。 */
  readonly skipped: boolean;
};

export type FailureViewData = {
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
  readonly job_id: string | null;
};

export type OutputViewData = {
  readonly text: string;
  readonly truncated: boolean;
  readonly masked: boolean;
};

export type LogViewData = OutputViewData & { readonly nonJsonLines: number };

export type JobDetailView =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly job: JobSummaryView;
      readonly args: readonly ArgViewData[];
      readonly steps: readonly StepViewData[];
      readonly log: LogViewData | null;
      readonly result: OutputViewData | null;
      readonly result_error: string | null;
      readonly failures:
        | { readonly ok: true; readonly items: readonly FailureViewData[] }
        | { readonly ok: false; readonly reason: string };
    };

export type JobListView = {
  readonly view: "active" | "history";
  readonly jobs: readonly JobSummaryView[];
  readonly next_before: string | null;
  readonly filter_rejected: boolean;
  readonly truncated: boolean;
};

export type RecentRunView = {
  readonly job_id: string;
  readonly success: boolean;
  readonly duration_ms: number | null;
};

export type ScheduleViewData = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly summary: string | null;
  readonly paused_until: string | null;
  readonly edited_at: string | null;
  readonly error: string | null;
  readonly next_run_at: string | null;
  readonly recent_runs: readonly RecentRunView[];
  readonly definition: string;
  readonly differences: readonly string[];
};

export type SchedulesSnapshotView = {
  readonly schedules: readonly ScheduleViewData[];
  readonly missing_in_workspace: readonly string[];
  readonly truncated: boolean;
};

export type ConfigItemView =
  | {
      readonly key: string;
      readonly kind: "value";
      readonly value: unknown;
      readonly masked: boolean;
    }
  | { readonly key: string; readonly kind: "reference" };

export type ConfigSnapshotView = {
  readonly path: string;
  readonly items: readonly ConfigItemView[];
};

// stateやdefinitionは表示にしか使わないので文字列で受け、日本語への変換で知らない値を受け止める。
// backendが先に新しい値を反映した間も、一覧の全体が消えないためである。

const isJobSummary: Guard<JobSummaryView> = (
  value: unknown,
): value is JobSummaryView =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.state) &&
  isString(value.script_path) &&
  isString(value.job_kind) &&
  isNullableString(value.created_at) &&
  isNullableString(value.started_at) &&
  isNullableString(value.completed_at) &&
  isNullableString(value.scheduled_for) &&
  isNullableInteger(value.duration_ms) &&
  isNullableString(value.schedule_path) &&
  isNullableString(value.parent_job) &&
  isString(value.tag) &&
  isBoolean(value.is_flow_step);

const isArgView: Guard<ArgViewData> = (value: unknown): value is ArgViewData =>
  isRecord(value) &&
  isString(value.key) &&
  isString(value.type) &&
  (!("value" in value) ||
    value.value === null ||
    isString(value.value) ||
    isBoolean(value.value) ||
    (typeof value.value === "number" && Number.isFinite(value.value)));

const isStepView: Guard<StepViewData> = (
  value: unknown,
): value is StepViewData =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.state) &&
  isNullableString(value.job_id) &&
  isNullableInteger(value.iterations);

const isFailureView: Guard<FailureViewData> = (
  value: unknown,
): value is FailureViewData =>
  isRecord(value) &&
  isNullableString(value.step) &&
  isString(value.error) &&
  isString(value.occurred_at) &&
  isNullableString(value.job_id);

function isOutputView(value: unknown): value is OutputViewData {
  return (
    isRecord(value) &&
    isString(value.text) &&
    isBoolean(value.truncated) &&
    isBoolean(value.masked)
  );
}

function isLogView(value: unknown): value is LogViewData {
  return (
    isOutputView(value) &&
    "nonJsonLines" in value &&
    isInteger(value.nonJsonLines)
  );
}

function isFailures(value: unknown): boolean {
  if (!isRecord(value) || !isBoolean(value.ok)) return false;
  return value.ok
    ? isArrayOf(isFailureView)(value.items)
    : isString(value.reason);
}

/** `value`がconsole_jobsの一覧の戻りの形か。 */
export function isJobList(value: unknown): value is JobListView {
  return (
    isRecord(value) &&
    isOneOf(["active", "history"] as const)(value.view) &&
    isArrayOf(isJobSummary)(value.jobs) &&
    isNullableString(value.next_before) &&
    isBoolean(value.filter_rejected) &&
    isBoolean(value.truncated)
  );
}

/** `value`がconsole_jobsの詳細の戻りの形か。見つからない応答も正しい形として受ける。 */
export function isJobDetail(value: unknown): value is JobDetailView {
  if (!isRecord(value) || !isBoolean(value.found)) return false;
  if (!value.found) return true;
  return (
    isJobSummary(value.job) &&
    isArrayOf(isArgView)(value.args) &&
    isArrayOf(isStepView)(value.steps) &&
    isNullable(isLogView)(value.log) &&
    isNullable(isOutputView)(value.result) &&
    isNullableString(value.result_error) &&
    isFailures(value.failures)
  );
}

const isRecentRun: Guard<RecentRunView> = (
  value: unknown,
): value is RecentRunView =>
  isRecord(value) &&
  isString(value.job_id) &&
  isBoolean(value.success) &&
  isNullableInteger(value.duration_ms);

const isScheduleView: Guard<ScheduleViewData> = (
  value: unknown,
): value is ScheduleViewData =>
  isRecord(value) &&
  isString(value.path) &&
  isString(value.script_path) &&
  isBoolean(value.is_flow) &&
  isString(value.schedule) &&
  isString(value.timezone) &&
  isBoolean(value.enabled) &&
  isNullableString(value.summary) &&
  isNullableString(value.paused_until) &&
  isNullableString(value.edited_at) &&
  isNullableString(value.error) &&
  isNullableString(value.next_run_at) &&
  isArrayOf(isRecentRun)(value.recent_runs) &&
  isString(value.definition) &&
  isArrayOf(isString)(value.differences);

/** `value`がconsole_schedulesの戻りの形か。 */
export function isSchedulesSnapshot(
  value: unknown,
): value is SchedulesSnapshotView {
  return (
    isRecord(value) &&
    isArrayOf(isScheduleView)(value.schedules) &&
    isArrayOf(isString)(value.missing_in_workspace) &&
    isBoolean(value.truncated)
  );
}

const isConfigItem: Guard<ConfigItemView> = (
  value: unknown,
): value is ConfigItemView => {
  if (!isRecord(value) || !isString(value.key)) return false;
  if (value.kind === "reference") return true;
  return value.kind === "value" && "value" in value && isBoolean(value.masked);
};

/** `value`がconsole_configの戻りの形か。 */
export function isConfigSnapshot(value: unknown): value is ConfigSnapshotView {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isArrayOf(isConfigItem)(value.items)
  );
}

export type HistoryFilter = {
  readonly status?: string;
  readonly scriptPath?: string;
  readonly before?: string;
};

export type DetailParams = {
  /** ログと結果も取る。実行中の状態の取り直しは偽にして、ログを取り直さない。 */
  readonly includeOutput: boolean;
  /**
   * 実行中か待ちのジョブを取り直していると、画面が知っているか。
   * 状態の取得にまだ値が無いときも、この値が真なら15秒ごとの取り直しを続ける。
   */
  readonly expectActive?: boolean;
};

/** 実行中のジョブの状態を取り直す間隔。 */
export const JOB_DETAIL_REFRESH_MS = 15_000;

/** 一覧が新しいとみなす間隔。自動では取り直さず、更新の操作で取り直す。 */
export const JOBS_LIST_STALE_MS = 60_000;

export const jobsActiveQueryKey = ["console", "jobs", "active"] as const;
export const schedulesQueryKey = ["console", "schedules"] as const;
export const configQueryKey = ["console", "config"] as const;

/** 履歴のキャッシュのキー。ページ(`before`)ごとに別のキャッシュにする。 */
export function jobsHistoryQueryKey(filter: HistoryFilter): readonly string[] {
  return [
    "console",
    "jobs",
    "history",
    filter.status ?? "",
    filter.scriptPath ?? "",
    filter.before ?? "",
  ];
}

export function jobDetailQueryKey(
  id: string,
  params: DetailParams,
): readonly string[] {
  return [
    "console",
    "jobs",
    "detail",
    id,
    params.includeOutput ? "output" : "status",
  ];
}

async function fetchChecked<T>(
  args: Readonly<Record<string, unknown>>,
  script: "console_jobs" | "console_schedules" | "console_config",
  guard: Guard<T>,
  options: RunScriptOptions,
): Promise<T> {
  const result = await runScript(script, args, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!guard(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 実行中と待ちのジョブを取る。失敗は`ApiFailure`で投げる。 */
export function fetchActiveJobs(
  options: RunScriptOptions = {},
): Promise<JobListView> {
  return fetchChecked({ view: "active" }, "console_jobs", isJobList, options);
}

/** 完了した履歴を1ページ取る。設定した絞り込みだけを送る。 */
export function fetchJobHistory(
  filter: HistoryFilter,
  options: RunScriptOptions = {},
): Promise<JobListView> {
  return fetchChecked(
    {
      view: "history",
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.scriptPath !== undefined
        ? { script_path: filter.scriptPath }
        : {}),
      ...(filter.before !== undefined ? { before: filter.before } : {}),
    },
    "console_jobs",
    isJobList,
    options,
  );
}

/** ジョブ1件の詳細を取る。 */
export function fetchJobDetail(
  id: string,
  params: DetailParams,
  options: RunScriptOptions = {},
): Promise<JobDetailView> {
  return fetchChecked(
    { view: "detail", job_id: id, include_output: params.includeOutput },
    "console_jobs",
    isJobDetail,
    options,
  );
}

/** scheduleの状態を取る。 */
export function fetchSchedules(
  options: RunScriptOptions = {},
): Promise<SchedulesSnapshotView> {
  return fetchChecked({}, "console_schedules", isSchedulesSnapshot, options);
}

/** 設定の全項目を取る。 */
export function fetchConfig(
  options: RunScriptOptions = {},
): Promise<ConfigSnapshotView> {
  return fetchChecked({}, "console_config", isConfigSnapshot, options);
}

type DetailQueryState = {
  readonly state: { readonly data: JobDetailView | undefined };
};

const LIST_POLICY = {
  refetchInterval: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: JOBS_LIST_STALE_MS,
} as const;

/** 実行中と待ちのジョブの取得の設定。自動では取り直さない。 */
export function jobsActiveQueryOptions() {
  return {
    queryKey: jobsActiveQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchActiveJobs({ signal }),
    ...LIST_POLICY,
  };
}

/** 履歴の1ページの取得の設定。自動では取り直さない。 */
export function jobHistoryQueryOptions(filter: HistoryFilter) {
  return {
    queryKey: jobsHistoryQueryKey(filter),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchJobHistory(filter, { signal }),
    ...LIST_POLICY,
  };
}

/**
 * ジョブの詳細の取得の設定。
 * ログと結果を含む取得(`includeOutput`)は、古くならず、フォーカス、再接続、画面を開き直したときにも取り直さない。
 * ログの更新は操作で行い、終了の検知は`useJobDetail`が1回だけ行う。
 * 含まない取得は、ジョブが実行中か待ちのあいだ、タブが見えている間だけ15秒ごとに取り直す。
 * 15秒は新しいとみなし、ログと結果の取得の直後に重ねて取らない。フォーカスと再接続では取り直さない。
 */
export function jobDetailQueryOptions(id: string, params: DetailParams) {
  return {
    queryKey: jobDetailQueryKey(id, params),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchJobDetail(id, params, { signal }),
    staleTime: params.includeOutput
      ? Number.POSITIVE_INFINITY
      : JOB_DETAIL_REFRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: !params.includeOutput,
    refetchInterval: (query: DetailQueryState): number | false => {
      if (params.includeOutput) return false;
      const data = query.state.data;
      if (data === undefined) {
        return params.expectActive === true ? JOB_DETAIL_REFRESH_MS : false;
      }
      return data.found && isActiveJobState(data.job.state)
        ? JOB_DETAIL_REFRESH_MS
        : false;
    },
    refetchIntervalInBackground: false,
  };
}

/** scheduleの状態の取得の設定。自動では取り直さない。 */
export function schedulesQueryOptions() {
  return {
    queryKey: schedulesQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchSchedules({ signal }),
    ...LIST_POLICY,
  };
}

/** 設定の取得の設定。自動では取り直さない。 */
export function configQueryOptions() {
  return {
    queryKey: configQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchConfig({ signal }),
    ...LIST_POLICY,
  };
}

/**
 * 状態を15秒ごとに取り直すか。最新の状態が実行中か待ちのときだけ取り直す。
 * 予定のジョブは取り直さない。実行が数時間先のことがあり、15秒ごとの取得が無駄になるためである。
 * 手動の更新で実行中になったときは、そのとき取り直しの対象になる。
 * ログと結果の取得中は取り直さない。Console用workerの枠が1つなので、2つの詳細の取得を重ねないためである。
 */
export function shouldPollJobStatus(
  latest: JobSummaryView | null,
  outputFetching: boolean,
): boolean {
  return !outputFetching && latest !== null && isActiveJobState(latest.state);
}

/** 履歴の2ページ目以降のキャッシュのキーか。先頭のページは`before`が空である。 */
export function isLaterHistoryPage(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === "console" &&
    queryKey[1] === "jobs" &&
    queryKey[2] === "history" &&
    typeof queryKey[5] === "string" &&
    queryKey[5] !== ""
  );
}

/** 詳細の取得の結果のうち、表示するジョブの選択に読む項目。 */
export type DetailSnapshot = {
  readonly data: JobDetailView | undefined;
  readonly updatedAt: number;
};

/**
 * 表示する詳細。ログと結果の取得と状態の取得のうち、新しい方にする。
 * 終了した状態から、実行中か待ちの状態へは戻さない。
 * 接続の復帰で2つを同時に読み直すと、先に出した状態の応答が後から届くことがあるためである。
 */
function currentDetail(
  output: DetailSnapshot,
  status: DetailSnapshot,
): Extract<JobDetailView, { found: true }> | null {
  if (output.data === undefined || !output.data.found) return null;
  const newer =
    status.data?.found === true && status.updatedAt > output.updatedAt;
  const regress =
    status.data?.found === true &&
    isFinishedJobState(output.data.job.state) &&
    isActiveJobState(status.data.job.state);
  return newer && !regress && status.data?.found === true
    ? status.data
    : output.data;
}

/** 表示するジョブ。ログと結果の取得と状態の取得のうち、新しい方のジョブにする。 */
export function currentJob(
  output: DetailSnapshot,
  status: DetailSnapshot,
): JobSummaryView | null {
  return currentDetail(output, status)?.job ?? null;
}

/** 表示するステップ。ジョブと同じく、新しい方の取得から取る。状態の取得は、ステップも持っている。 */
export function currentSteps(
  output: DetailSnapshot,
  status: DetailSnapshot,
): readonly StepViewData[] {
  return currentDetail(output, status)?.steps ?? [];
}

/** 実行中と待ちのジョブを取る。`enabled`が偽の間は取らない(開いていないタブの取得を避ける)。 */
export function useActiveJobs(
  enabled: boolean,
): UseQueryResult<JobListView, Error> {
  return useQuery({ ...jobsActiveQueryOptions(), enabled });
}

/** scheduleの状態を取る。`enabled`が偽の間は取らない。 */
export function useSchedules(
  enabled: boolean,
): UseQueryResult<SchedulesSnapshotView, Error> {
  return useQuery({ ...schedulesQueryOptions(), enabled });
}

/** 設定の全項目を取る。`enabled`が偽の間は取らない。 */
export function useConfig(
  enabled: boolean,
): UseQueryResult<ConfigSnapshotView, Error> {
  return useQuery({ ...configQueryOptions(), enabled });
}

/**
 * 状態の取得を、ログと結果の取得の値で初期化する。
 * 状態の取得が新しい値を持つときは上書きしない。ログと結果の取得が見つからなかったときと、未取得のときは何もしない。
 * 初期化した値の時刻は、ログと結果を取った時刻に合わせる。取った直後に、状態を重ねて取らないためである。
 */
export function seedJobStatus(
  client: QueryClient,
  id: string,
  output: DetailSnapshot,
): void {
  if (output.data === undefined || !output.data.found) return;
  const key = jobDetailQueryKey(id, { includeOutput: false });
  const current = client.getQueryState(key);
  if (
    current?.data !== undefined &&
    current.dataUpdatedAt >= output.updatedAt
  ) {
    return;
  }
  client.setQueryData(key, output.data, { updatedAt: output.updatedAt });
}

/**
 * ジョブが終わったと分かったとき、ログと結果を取り直すか。
 * ログと結果を取った時点で終わっていなかったので、終わった後の出力と原因を読めていないためである。
 * 予定のジョブが、手動の更新で実行中になり、終わったときも同じである。
 * どちらかの取得中は取り直さない。Console用workerの枠が1つなので、2つの詳細の取得を重ねないためである。
 */
export function shouldRefetchOutputAfterFinish(
  output: JobDetailView | undefined,
  status: JobDetailView | undefined,
  busy: { readonly outputFetching: boolean; readonly statusFetching: boolean },
): boolean {
  if (busy.outputFetching || busy.statusFetching) return false;
  if (output === undefined || !output.found) return false;
  if (status === undefined || !status.found) return false;
  return (
    !isFinishedJobState(output.job.state) &&
    isFinishedJobState(status.job.state)
  );
}

/** ログと結果の取り直しを、このidでこれから始めるか。同じidでは1回しか始めない。失敗しても、取り直し続けない。 */
export function shouldStartOutputRefetch(
  finished: boolean,
  doneFor: string | null,
  id: string,
): boolean {
  return finished && doneFor !== id;
}

/**
 * 詳細の取得の失敗から、取り直す取得を、実行する順に返す。
 * 失敗した取得だけを返し、ログと結果を先にする。
 * Console用workerの枠が1つなので、2つを同時に走らせないためである。
 */
export function failedDetailReads(
  outputFailed: boolean,
  statusFailed: boolean,
): readonly ("output" | "status")[] {
  return [
    ...(outputFailed ? (["output"] as const) : []),
    ...(statusFailed ? (["status"] as const) : []),
  ];
}

/**
 * ジョブの詳細を取る。ログと結果を含む取得を1回行い、最新の状態が実行中か待ちのときだけ、状態の取得を別に持つ。
 * 状態の取得は、ログと結果の取得が終わっている間だけ有効にして、2つが同時に走らないようにする。
 * 予定のジョブは自動では取り直さない。手動の更新で実行中になったら、取り直しの対象になる。
 * 有効になる前に、ログと結果の値で状態の取得を初期化する。直後に同じ内容を取り直さないためである。
 * その後は15秒ごとに繰り返す。タブが見えない間は止まる。
 * 終わっていなかったジョブが終わったと分かったときは、ログと結果を1回だけ取り直す。失敗しても繰り返さない。
 * ログと原因は「ログと原因を更新」の操作でも取り直せる。
 */
export function useJobDetail(id: string): {
  readonly output: UseQueryResult<JobDetailView, Error>;
  readonly status: UseQueryResult<JobDetailView, Error>;
} {
  const client = useQueryClient();
  const output = useQuery(jobDetailQueryOptions(id, { includeOutput: true }));
  // 状態の取得の購読より前に初期化する。購読の後だと、値が無いまま1回取ってしまう。
  useEffect(() => {
    seedJobStatus(client, id, {
      data: output.data,
      updatedAt: output.dataUpdatedAt,
    });
  }, [client, id, output.data, output.dataUpdatedAt]);
  const outputJob =
    output.data !== undefined && output.data.found ? output.data.job : null;
  // 有効かどうかは、最新の状態から決める。状態の取得の値が新しければ、そちらを見る。
  const status = useQuery({
    ...jobDetailQueryOptions(id, {
      includeOutput: false,
      expectActive: outputJob !== null && isActiveJobState(outputJob.state),
    }),
    enabled: (query) =>
      shouldPollJobStatus(
        currentJob(
          { data: output.data, updatedAt: output.dataUpdatedAt },
          { data: query.state.data, updatedAt: query.state.dataUpdatedAt },
        ),
        output.isFetching,
      ),
  });

  const refetchedFor = useRef<string | null>(null);
  const finished = shouldRefetchOutputAfterFinish(output.data, status.data, {
    outputFetching: output.isFetching,
    statusFetching: status.isFetching,
  });
  const { refetch } = output;
  useEffect(() => {
    if (shouldStartOutputRefetch(finished, refetchedFor.current, id)) {
      refetchedFor.current = id;
      void refetch();
    }
  }, [finished, id, refetch]);
  return { output, status };
}

/**
 * ジョブの画面が、スケジュールの凍結の突き合わせに使う保留と凍結の取得の設定。
 * 定期の取り直しも、フォーカスと再接続での取り直しもしない。画面の更新の操作で取り直す。
 * Console用workerの枠が1つで、取得が承認などの呼び出しを待たせるためである。
 */
export function jobsHoldsQueryOptions() {
  return {
    ...holdsQueryOptions(),
    refetchInterval: false as const,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
  };
}

/** 実行中のflowの今のステップを取り直す間隔。 */
export const ACTIVE_STEPS_REFRESH_MS = 30_000;

/** 今のステップの取得のキーの先頭。 */
export const activeStepsQueryKeyBase = ["console", "jobs", "steps"] as const;

export function activeStepsQueryKey(ids: readonly string[]): readonly string[] {
  return [...activeStepsQueryKeyBase, ...ids];
}

/** ログと結果を含めずに、ジョブ1件の詳細を読む。 */
export type ActiveStepRead = (id: string) => Promise<JobDetailView>;

export async function fetchActiveJobSteps(
  _ids: readonly string[],
  _read: ActiveStepRead,
): Promise<StepDetails> {
  return new Map();
}

const NO_INTERVAL: number | false = false;

export function activeStepsQueryOptions(ids: readonly string[]) {
  return {
    queryKey: activeStepsQueryKey(ids),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchActiveJobSteps(ids, (id) =>
        fetchJobDetail(id, { includeOutput: false }, { signal }),
      ),
    staleTime: 0,
    refetchInterval: NO_INTERVAL,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  };
}

export async function refreshActiveThenSteps(_reads: {
  readonly active: () => Promise<unknown>;
  readonly steps: () => Promise<unknown>;
}): Promise<void> {
  return undefined;
}

export async function invalidateAfterFinish(
  _client: QueryClient,
): Promise<void> {
  return undefined;
}

export type ActiveJobStepsView = {
  readonly details: StepDetails;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
};

/** 実行中のflowの今のステップを読む。 */
export function useActiveJobSteps(
  _list: JobListView | undefined,
  _selectedTab: JobsTabId,
): ActiveJobStepsView {
  return {
    details: new Map(),
    isFetching: false,
    refetch: () => Promise.resolve(undefined),
  };
}
