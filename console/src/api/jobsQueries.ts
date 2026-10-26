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
 * 実行中か待ちのジョブの状態を取り直すか。
 * ログと結果の取得中は取り直さない。Console用workerの枠が1つなので、2つの詳細の取得を重ねないためである。
 */
export function shouldPollJobStatus(
  _latest: JobSummaryView | null,
  _outputFetching: boolean,
): boolean {
  return false;
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

/** 表示するジョブ。ログと結果の取得と状態の取得のうち、新しい方のジョブにする。 */
export function currentJob(
  output: DetailSnapshot,
  status: DetailSnapshot,
): JobSummaryView | null {
  if (output.data === undefined || !output.data.found) return null;
  if (status.data?.found === true && status.updatedAt > output.updatedAt) {
    return status.data.job;
  }
  return output.data.job;
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
 * 実行中だったジョブが終わったとき、ログと結果を1回取り直すか。
 * ログと結果は、実行中のうちに取ったもので、終わった後の出力と原因を読めていないためである。
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
    isActiveJobState(output.job.state) && isFinishedJobState(status.job.state)
  );
}

/**
 * ジョブの詳細を取る。ログと結果を含む取得を1回行い、実行中か待ちのときだけ、状態の取得を別に持つ。
 * 状態の取得は、ログと結果の取得が終わっている間だけ有効にして、2つが同時に走らないようにする。
 * 有効になる前に、ログと結果の値で状態の取得を初期化する。直後に同じ内容を取り直さないためである。
 * その後は15秒ごとに繰り返す。タブが見えない間は止まる。
 * 実行中だったジョブが終わったと分かったときは、ログと結果を1回だけ取り直す。
 * ログは「ログを更新」の操作でも取り直せる。
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
  const enabled = shouldPollJobStatus(output.data, output.isFetching);
  const status = useQuery({
    ...jobDetailQueryOptions(id, {
      includeOutput: false,
      expectActive: enabled,
    }),
    enabled,
  });

  const refetchedFor = useRef<string | null>(null);
  const finished = shouldRefetchOutputAfterFinish(output.data, status.data, {
    outputFetching: output.isFetching,
    statusFetching: status.isFetching,
  });
  const { refetch } = output;
  useEffect(() => {
    if (finished && refetchedFor.current !== id) {
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

/** 表示する詳細のステップ。ログと結果の取得と状態の取得のうち、新しい方のステップにする。 */
export function currentSteps(
  _output: DetailSnapshot,
  _status: DetailSnapshot,
): readonly StepViewData[] {
  return [];
}

/** ログと結果の取り直しを、このidでこれから始めるか。同じidでは1回しか始めない。 */
export function shouldStartOutputRefetch(
  _finished: boolean,
  _doneFor: string | null,
  _id: string,
): boolean {
  return false;
}

/** 詳細の取得の失敗から、取り直す取得を、実行する順に返す。2つを同時に走らせない。 */
export function failedDetailReads(
  _outputFailed: boolean,
  _statusFailed: boolean,
): readonly ("output" | "status")[] {
  return [];
}
