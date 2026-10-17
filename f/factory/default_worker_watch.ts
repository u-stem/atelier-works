// defaultのworkerが止まっていないかを5分ごとに確かめる(テスト先行のための仮の実装)。

import type { ListQueueData } from "windmill-client@1.817.0";
import type { DefaultWorkerCheckDeps } from "./lib/default_worker.ts";
import type { NotifyEvent } from "./lib/discord.ts";
import type { Logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";

export type DefaultWorkerWatchIo = {
  readonly workspace: string;
  readonly listQueue: (query: ListQueueData) => Promise<unknown>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
    resolvedBy: string,
  ) => Promise<number>;
  readonly getWebhookUrl: () => Promise<string>;
  readonly notifyBestEffort: (
    webhookUrl: string,
    event: NotifyEvent,
    log: Logger,
  ) => Promise<unknown>;
};

export function buildWatchDeps(
  _io: DefaultWorkerWatchIo,
  instanceName: string,
  log: Logger,
): DefaultWorkerCheckDeps {
  return {
    listRunningJobs: async () => [],
    listWaitingJobs: async () => [],
    now: () => 0,
    addNotice: async () => null,
    resolveNotices: async () => 0,
    notify: async () => undefined,
    instanceName,
    log,
  };
}
