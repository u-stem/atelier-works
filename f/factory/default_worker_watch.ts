// defaultのworkerが止まっていないかと、scheduleの失敗を拾う検出器が止まっていないかを、5分ごとに確かめるscript。
// 判定と通知は`./lib/default_worker.ts`と`./lib/schedule_detector_heartbeat.ts`にあり、このファイルは入出力をつなぐだけ。
// tag `periodic`のworkerで動かす。defaultのworkerの中で動くscriptは、そのworkerが止まると動かず、
// 止まったことを知らせられないため。逆に定期ジョブ用のworkerが止まったことは、
// defaultのworkerで動く`self_update`が確かめる(`./lib/periodic_worker.ts`)。
// 検出器の確認は、defaultのworkerの確認の後に、独立して行う。どちらの失敗も、もう一方を止めない。
// 検出器自身は別のscript(`detect_schedule_failures`)で、見る側と見られる側が同じにならないようにしている。
// 読むsecretは通知先の`discord_webhook_url`だけである。
// tag periodicを付けたscriptの境界は`tests/scripts/periodic_script_boundary.test.ts`が固定する。

import type {
  ListCompletedJobsData,
  ListQueueData,
} from "windmill-client@1.817.0";
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
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  checkScheduleDetector,
  type ScheduleDetectorCheck,
  type ScheduleDetectorCheckDeps,
} from "./lib/schedule_detector_heartbeat.ts";
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
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  readonly getSchedule: (path: string) => Promise<unknown>;
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

/** 検出器の確認が使う依存を、入出力から組み立てる。 */
export function buildHeartbeatDeps(
  io: DefaultWorkerWatchIo,
  instanceName: string,
  log: Logger,
): ScheduleDetectorCheckDeps {
  return {
    workspace: io.workspace,
    now: () => Date.now(),
    listCompletedJobs: io.listCompletedJobs,
    getSchedule: io.getSchedule,
    addNotice: io.addNotice,
    resolveNotices: (kind, messagePrefix) =>
      io.resolveNotices(kind, messagePrefix, DEFAULT_WORKER_NOTICE_RESOLVER),
    notify: async (event) => {
      await io.notifyBestEffort(await io.getWebhookUrl(), event, log);
    },
    instanceName,
    log,
  };
}

/** 2つの確認の実体。テストでは差し替える。 */
export type WatchChecks = {
  readonly defaultWorker: (
    deps: DefaultWorkerCheckDeps,
  ) => Promise<DefaultWorkerCheck>;
  readonly scheduleDetector: (
    deps: ScheduleDetectorCheckDeps,
  ) => Promise<ScheduleDetectorCheck>;
};

const DEFAULT_CHECKS: WatchChecks = {
  defaultWorker: checkDefaultWorker,
  scheduleDetector: checkScheduleDetector,
};

export type WatchOutcome = {
  readonly result: DefaultWorkerCheck;
  /** 検出器の確認が例外を投げたときは`error`。 */
  readonly schedule_detector: ScheduleDetectorCheck | "error";
};

/**
 * defaultのworkerの確認の後に、検出器の確認を行う。
 * 検出器の確認が例外を投げても、defaultのworkerの結果は返す。
 * 検出器の確認は自分で時間を区切る。defaultのworkerの確認の最悪の長さに足した値が、このscriptのtimeoutに収まることを、テストが固定する。
 */
export async function runWatchChecks(
  io: DefaultWorkerWatchIo,
  instanceName: string,
  log: Logger,
  checks: WatchChecks = DEFAULT_CHECKS,
): Promise<WatchOutcome> {
  const result = await checks.defaultWorker(
    buildWatchDeps(io, instanceName, log),
  );
  let scheduleDetector: ScheduleDetectorCheck | "error" = "error";
  try {
    scheduleDetector = await checks.scheduleDetector(
      buildHeartbeatDeps(io, instanceName, log),
    );
  } catch (err) {
    log.warn("schedule detector check failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
  return { result, schedule_detector: scheduleDetector };
}

export async function main(): Promise<WatchOutcome> {
  const log = logger("default_worker_watch");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const outcome = await runWatchChecks(
    {
      workspace: wmillDefault.getWorkspace(),
      listQueue: (query) => wmill.JobService.listQueue(query),
      listCompletedJobs: (query) => wmill.JobService.listCompletedJobs(query),
      getSchedule: (path) =>
        wmill.ScheduleService.getSchedule({
          workspace: wmillDefault.getWorkspace(),
          path,
        }),
      addNotice: addNoticeUnlessUnresolved,
      resolveNotices: resolveUnresolvedNoticesByPrefix,
      getWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
      notifyBestEffort,
    },
    config.instance_name,
    log,
  );
  log.info("default worker and schedule detector checked", { ...outcome });
  return outcome;
}
