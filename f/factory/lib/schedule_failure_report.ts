import type { JobIds } from "./job_ids.ts";
import type { Logger } from "./log.ts";
import type { PreviousScheduleFailure } from "./schedule_failing.ts";
import type { FailureRecord } from "./types.ts";

export type ScheduleFailureInput = {
  readonly flowPath: string;
  readonly jobId: string;
  readonly error: string;
  readonly occurredAt: string;
  readonly runs: unknown;
  readonly previousFailure: PreviousScheduleFailure | null;
};

export type ScheduleFailureReportDeps = {
  readonly isRecorded: (jobId: string) => boolean | Promise<boolean>;
  readonly recordFailure: (
    record: FailureRecord,
    jobIds: JobIds,
  ) => Promise<number>;
  readonly log: Logger;
};

export type ScheduleFailureReport = {
  readonly status: "recorded" | "already_recorded" | "record_failed";
  readonly notify: boolean;
};

export async function reportScheduleFailure(
  _input: ScheduleFailureInput,
  _deps: ScheduleFailureReportDeps,
): Promise<ScheduleFailureReport> {
  return { status: "recorded", notify: false };
}
