// 定期ジョブ用のworkerがtag `periodic`のジョブを受けているかを確かめる(実装は次のコミット)。

import type { ListQueueData } from "windmill-client@1.817.0";
import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const PERIODIC_WORKER_TAG = "";

export const PERIODIC_JOB_WAIT_SECONDS = 0;

export const PERIODIC_WORKER_CHECK_TIMEOUT_MS = 0;

export const PERIODIC_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "",
  message: "",
};

export function periodicQueueQuery(_workspace: string): ListQueueData {
  return { workspace: "" };
}

export type PeriodicWorkerCheck = "ok" | "stalled" | "unknown";

export function judgePeriodicQueue(
  _waitingJobs: unknown,
  _nowMs: number,
): PeriodicWorkerCheck {
  return "unknown";
}

export type PeriodicWorkerCheckDeps = {
  readonly listWaitingJobs: () => Promise<unknown>;
  readonly now: () => number;
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

export async function checkPeriodicWorker(
  _deps: PeriodicWorkerCheckDeps,
): Promise<PeriodicWorkerCheck> {
  return "unknown";
}
