import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { NotifyEvent } from "./lib/discord.ts";
import type { JobIds } from "./lib/job_ids.ts";
import type { Logger } from "./lib/log.ts";
import type { PreviousScheduleFailure } from "./lib/schedule_failing.ts";
import type { ScheduleFailureDetectDeps } from "./lib/schedule_failure_detect.ts";
import type { FailureRecord, NoticeRecord } from "./lib/types.ts";

export type DetectScheduleFailuresIo = {
  readonly workspace: string;
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
  readonly getInstanceName: () => Promise<string>;
  readonly getWebhookUrl: () => Promise<string>;
  readonly notify: (webhookUrl: string, event: NotifyEvent) => Promise<unknown>;
};

export function buildDetectDeps(
  io: DetectScheduleFailuresIo,
  log: Logger,
): ScheduleFailureDetectDeps {
  return {
    workspace: "",
    now: () => 0,
    listCompletedJobs: async () => [],
    getCompletedJobResult: async () => ({}),
    getJob: async () => ({}),
    listRecordedJobIds: io.listRecordedJobIds,
    getLatestFailure: io.getLatestFailure,
    recordFailure: io.recordFailure,
    addNotice: io.addNotice,
    sendJobFailed: async () => undefined,
    log,
  };
}

export async function main(): Promise<{ readonly mode: string }> {
  return { mode: "scan" };
}
