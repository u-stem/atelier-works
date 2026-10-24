import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { JobIds } from "./job_ids.ts";
import type { Logger } from "./log.ts";
import type { PreviousScheduleFailure } from "./schedule_failing.ts";
import type { FailureRecord, NoticeRecord } from "./types.ts";

export type ScheduleFailureDetectDeps = {
  readonly workspace: string;
  readonly now: () => number;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly listRecordedJobIds: (
    jobIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly getLatestFailure: (
    flowPath: string,
  ) => Promise<PreviousScheduleFailure | null>;
  readonly recordFailure: (
    record: FailureRecord,
    jobIds: JobIds,
  ) => Promise<number>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly sendJobFailed: (failure: {
    readonly flowPath: string;
    readonly jobId: string;
    readonly error: string;
  }) => Promise<void>;
  readonly log: Logger;
};

export type ScheduleFailureDetectResult = {
  readonly mode: "bootstrap" | "scan";
  readonly processed_until: string;
  readonly found: number;
  readonly recorded: number;
  readonly truncated: boolean;
};

export async function detectScheduleFailures(
  _deps: ScheduleFailureDetectDeps,
): Promise<ScheduleFailureDetectResult> {
  return {
    mode: "scan",
    processed_until: "",
    found: 0,
    recorded: 0,
    truncated: false,
  };
}
