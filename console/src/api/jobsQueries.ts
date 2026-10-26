// ジョブ・schedule・設定の読み取りの型、型ガード、取得(スタブ)。

import type { RunScriptOptions } from "./windmill.ts";

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
      readonly failures:
        | { readonly ok: true; readonly items: readonly FailureViewData[] }
        | { readonly ok: false; readonly reason: string };
    };

export type JobListView = {
  readonly view: "active" | "history";
  readonly jobs: readonly JobSummaryView[];
  readonly next_before: string | null;
  readonly filter_rejected: boolean;
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

export type HistoryFilter = {
  readonly status?: string;
  readonly scriptPath?: string;
  readonly before?: string;
  readonly includeConsole?: boolean;
};

export type DetailParams = { readonly includeOutput: boolean };

export const JOB_DETAIL_REFRESH_MS = 0;

export const jobsActiveQueryKey: readonly string[] = [];
export const schedulesQueryKey: readonly string[] = [];
export const configQueryKey: readonly string[] = [];

export function jobsHistoryQueryKey(_filter: HistoryFilter): readonly string[] {
  return [];
}

export function jobDetailQueryKey(
  _id: string,
  _params: DetailParams,
): readonly string[] {
  return [];
}

export function isJobList(_value: unknown): _value is JobListView {
  return false;
}

export function isJobDetail(_value: unknown): _value is JobDetailView {
  return false;
}

export function isSchedulesSnapshot(
  _value: unknown,
): _value is SchedulesSnapshotView {
  return false;
}

export function isConfigSnapshot(
  _value: unknown,
): _value is ConfigSnapshotView {
  return false;
}

const EMPTY_LIST: JobListView = {
  view: "active",
  jobs: [],
  next_before: null,
  filter_rejected: false,
};

export async function fetchActiveJobs(
  _options: RunScriptOptions = {},
): Promise<JobListView> {
  return EMPTY_LIST;
}

export async function fetchJobHistory(
  _filter: HistoryFilter,
  _options: RunScriptOptions = {},
): Promise<JobListView> {
  return EMPTY_LIST;
}

export async function fetchJobDetail(
  _id: string,
  _params: DetailParams,
  _options: RunScriptOptions = {},
): Promise<JobDetailView> {
  return { found: false };
}

export async function fetchSchedules(
  _options: RunScriptOptions = {},
): Promise<SchedulesSnapshotView> {
  return { schedules: [], missing_in_workspace: [] };
}

export async function fetchConfig(
  _options: RunScriptOptions = {},
): Promise<ConfigSnapshotView> {
  return { path: "", items: [] };
}

type DetailQueryState = {
  readonly state: { readonly data: JobDetailView | undefined };
};

const WRONG_INTERVAL: number | false = 1;
const WRONG_FLAG: boolean = true;

export function jobsActiveQueryOptions() {
  return {
    queryKey: jobsActiveQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchActiveJobs({ signal }),
    refetchInterval: WRONG_INTERVAL,
    refetchOnWindowFocus: WRONG_FLAG,
  };
}

export function jobHistoryQueryOptions(filter: HistoryFilter) {
  return {
    queryKey: jobsHistoryQueryKey(filter),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchJobHistory(filter, { signal }),
    refetchInterval: WRONG_INTERVAL,
    refetchOnWindowFocus: WRONG_FLAG,
  };
}

export function jobDetailQueryOptions(id: string, params: DetailParams) {
  return {
    queryKey: jobDetailQueryKey(id, params),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchJobDetail(id, params, { signal }),
    refetchInterval: (_query: DetailQueryState): number | false =>
      WRONG_INTERVAL,
    refetchIntervalInBackground: WRONG_FLAG,
  };
}

export function schedulesQueryOptions() {
  return {
    queryKey: schedulesQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchSchedules({ signal }),
    refetchInterval: WRONG_INTERVAL,
    refetchOnWindowFocus: WRONG_FLAG,
  };
}

export function configQueryOptions() {
  return {
    queryKey: configQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchConfig({ signal }),
    refetchInterval: WRONG_INTERVAL,
    refetchOnWindowFocus: WRONG_FLAG,
  };
}
