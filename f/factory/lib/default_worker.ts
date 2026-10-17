// defaultのworkerが止まっていないかを確かめる(テスト先行のための仮の実装)。

import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const DEFAULT_WORKER_WAIT_SECONDS = 0;

export const DEFAULT_WORKER_CHECK_TIMEOUT_MS = 0;

export const DEFAULT_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "",
  message: "",
};

export type DefaultWorkerCheck = "ok" | "stalled" | "unknown";

export function judgeDefaultQueue(
  _runningJobs: unknown,
  _waitingJobs: unknown,
  _nowMs: number,
): DefaultWorkerCheck {
  return "unknown";
}

export type DefaultWorkerCheckDeps = {
  readonly listRunningJobs: () => Promise<unknown>;
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

export async function checkDefaultWorker(
  _deps: DefaultWorkerCheckDeps,
): Promise<DefaultWorkerCheck> {
  return "unknown";
}
