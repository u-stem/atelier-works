// defaultのworkerが止まっていないかを5分ごとに確かめるscript。
// 判定と通知は`./lib/default_worker.ts`にあり、このファイルは入出力をつなぐだけ。
// tag `periodic`のworkerで動かす。defaultのworkerの中で動くscriptは、そのworkerが止まると動かず、
// 止まったことを知らせられないため。逆に定期ジョブ用のworkerが止まったことは、
// defaultのworkerで動く`self_update`が確かめる(`./lib/periodic_worker.ts`)。
// 読むsecretは通知先の`discord_webhook_url`だけである。
// tag periodicを付けたscriptの境界は`tests/scripts/periodic_script_boundary.test.ts`が固定する。

import type { ListQueueData } from "windmill-client@1.817.0";
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  resolveUnresolvedNoticesByPrefix,
} from "./lib/db.ts";
import {
  checkDefaultWorker,
  type DefaultWorkerCheck,
  type DefaultWorkerCheckDeps,
} from "./lib/default_worker.ts";
import { type NotifyEvent, notifyBestEffort } from "./lib/discord.ts";
import { type Logger, logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";
import {
  runningQueueQuery,
  waitingQueueQuery,
} from "./lib/worker_load_support.ts";

/** 待ちが解けて自動で解決するときの、解決者の名前。 */
const DEFAULT_WORKER_NOTICE_RESOLVER = "default_worker_watch";

/** 配線が使う入出力。テストでは偽物に差し替える。 */
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

/** 確認が使う依存を、入出力から組み立てる。 */
export function buildWatchDeps(
  io: DefaultWorkerWatchIo,
  instanceName: string,
  log: Logger,
): DefaultWorkerCheckDeps {
  return {
    listRunningJobs: () => io.listQueue(runningQueueQuery(io.workspace)),
    listWaitingJobs: () => io.listQueue(waitingQueueQuery(io.workspace)),
    now: () => Date.now(),
    addNotice: io.addNotice,
    resolveNotices: (kind, messagePrefix) =>
      io.resolveNotices(kind, messagePrefix, DEFAULT_WORKER_NOTICE_RESOLVER),
    notify: async (event) => {
      await io.notifyBestEffort(await io.getWebhookUrl(), event, log);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    instanceName,
    log,
  };
}

export async function main(): Promise<{ readonly result: DefaultWorkerCheck }> {
  const log = logger("default_worker_watch");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const result = await checkDefaultWorker(
    buildWatchDeps(
      {
        workspace: wmillDefault.getWorkspace(),
        listQueue: (query) => wmill.JobService.listQueue(query),
        addNotice: addNoticeUnlessUnresolved,
        resolveNotices: resolveUnresolvedNoticesByPrefix,
        getWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
        notifyBestEffort,
      },
      config.instance_name,
      log,
    ),
  );
  log.info("default worker checked", { result });
  return { result };
}
