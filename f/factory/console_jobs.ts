// Consoleのジョブの画面が読む、ジョブの一覧と詳細を返すscript(スタブ)。

export const JOB_PATH_PREFIX = "f/factory/";
export const ALLOWED_JOB_KINDS = [
  "script",
  "flow",
  "flowscript",
  "flownode",
  "singlestepflow",
] as const;
export const ALLOWED_ARG_KEYS: readonly string[] = [];
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 50;

export type JobState =
  | "running"
  | "queued"
  | "scheduled"
  | "success"
  | "failure"
  | "canceled"
  | "skipped";

export type JobSummary = {
  readonly id: string;
  readonly state: JobState;
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

export type ArgView = {
  readonly key: string;
  readonly type: string;
  readonly value?: string | number | boolean | null;
};

export type StepView = {
  readonly id: string;
  readonly state: string;
  readonly job_id: string | null;
  readonly iterations: number | null;
};

export type FailureView = {
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
  readonly job_id: string | null;
};

export type FailureRow = {
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
  readonly job_id: string | null;
};

export type OutputView = {
  readonly text: string;
  readonly truncated: boolean;
  readonly masked: boolean;
};

export type JobDetail =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly job: JobSummary;
      readonly args: readonly ArgView[];
      readonly steps: readonly StepView[];
      readonly log: (OutputView & { readonly nonJsonLines: number }) | null;
      readonly result: OutputView | null;
      readonly failures:
        | { readonly ok: true; readonly items: readonly FailureView[] }
        | { readonly ok: false; readonly reason: string };
    };

export type JobList = {
  readonly view: "active" | "history";
  readonly jobs: readonly JobSummary[];
  readonly next_before: string | null;
  readonly filter_rejected: boolean;
};

export type QueueQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
  readonly tag?: string;
};

export type JobsQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
  readonly hasNullParent: boolean;
  readonly completedBefore: string;
  readonly tag?: string;
  readonly createdBefore?: string;
  readonly status?: "success" | "failure" | "canceled";
  readonly scriptPathExact?: string;
};

export type JobsPorts = {
  readonly now: () => Date;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly getJobLogs: (id: string) => Promise<string>;
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  readonly listQueue: (query: QueueQuery) => Promise<readonly unknown[]>;
  readonly listJobs: (query: JobsQuery) => Promise<readonly unknown[]>;
  readonly readFailures: (jobId: string) => Promise<readonly FailureRow[]>;
};

export type ListOptions = {
  readonly includeConsole: boolean;
};

export type HistoryOptions = ListOptions & {
  readonly status?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
};

export type DetailOptions = {
  readonly includeOutput: boolean;
};

export function isJobId(_value: string): boolean {
  return false;
}

export async function loadActiveJobs(
  _ports: JobsPorts,
  _options: ListOptions,
): Promise<JobList> {
  return {
    view: "history",
    jobs: [],
    next_before: "stub",
    filter_rejected: true,
  };
}

export async function loadJobHistory(
  _ports: JobsPorts,
  _options: HistoryOptions,
): Promise<JobList> {
  return {
    view: "active",
    jobs: [],
    next_before: "stub",
    filter_rejected: true,
  };
}

export async function loadJobDetail(
  _ports: JobsPorts,
  _id: string,
  _options: DetailOptions,
): Promise<JobDetail> {
  return { found: false };
}

export type JobsInput = {
  readonly view: string;
  readonly job_id?: string | undefined;
  readonly status?: string | undefined;
  readonly script_path?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
  readonly include_console?: boolean | undefined;
  readonly include_output?: boolean | undefined;
};

export async function runJobsView(
  _ports: JobsPorts,
  _input: JobsInput,
): Promise<JobList | JobDetail> {
  return { found: false };
}

export async function main(
  _view: string,
  _job_id?: string,
  _status?: string,
  _script_path?: string,
  _before?: string,
  _limit?: number,
  _include_console?: boolean,
  _include_output?: boolean,
): Promise<JobList | JobDetail> {
  return { found: false };
}
