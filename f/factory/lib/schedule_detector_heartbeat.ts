import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const SCHEDULE_DETECTOR_STALE_MS = 0;
export const SCHEDULE_DETECTOR_WATCH_RUNS = 0;
export const SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS = 0;
export const SCHEDULE_DETECTOR_WATCH_PATH = "";
export const SCHEDULE_DETECTOR_NOTICE_PREFIX = "";
export const SCHEDULE_DETECTOR_STALLED_NOTICE: NoticeRecord = {
  kind: "",
  message: "",
};
export const SCHEDULE_DETECTOR_DISABLED_NOTICE: NoticeRecord = {
  kind: "",
  message: "",
};

export type ScheduleDetectorCheck = "ok" | "stalled" | "disabled" | "unknown";

export type ScheduleDetectorCheckDeps = {
  readonly workspace: string;
  readonly now: () => number;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  readonly getSchedule: (path: string) => Promise<unknown>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
  ) => Promise<number>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  readonly timeoutMs?: number;
};

export async function checkScheduleDetector(
  _deps: ScheduleDetectorCheckDeps,
): Promise<ScheduleDetectorCheck> {
  return "ok";
}
