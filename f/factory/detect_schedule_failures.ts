// scheduleが起こしたジョブの失敗を、Windmillのジョブ履歴から拾って記録し、通知するscript。5分ごとに動く。
// このWindmillではscheduleの`on_failure`が呼ばれないので、失敗の入口はこのscriptだけである。
// 判定と記録は`./lib/schedule_failure_detect.ts`にあり、このファイルは入出力をつなぐだけ。
// tag `periodic`のworkerで動かす。defaultのworkerで動かすと、長いジョブ(implementは最長6時間)が枠を塞ぐ間、失敗の検知が止まるため。
// 読むsecretは、通知先の`discord_webhook_url`と、外部の死活監視の`heartbeat_url`だけである。
// 検出が成功した回の最後に、外部の死活監視を叩く(`afterDetection`)。叩かれなくなると、外のサービスが知らせる。
// 外部の死活監視を叩く前に、全停止の要対応の通知を、変数`f/factory/stop_all`に合わせる(`syncStopAllNotice`)。
// 全停止を置く操作はDiscordの送り先を読めないので、知らせはこのscriptが出す。
// 検出器が止まったことは、`default_worker_watch`が、このscriptの成功した実行の完了時刻から見つける。
// tag periodicを付けたscriptの境界は`tests/scripts/periodic_script_boundary.test.ts`が固定する。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getLatestScheduleFailure,
  listRecordedScheduleFailureJobIds,
  listUnresolvedNoticesByKind,
  recordFailure,
  resolveUnresolvedNoticesByPrefix,
} from "./lib/db.ts";
import { type NotifyEvent, notify, notifyBestEffort } from "./lib/discord.ts";
import { readVariableOrNull } from "./lib/freezes.ts";
import { type HeartbeatResult, pingHeartbeat } from "./lib/heartbeat.ts";
import type { JobIds } from "./lib/job_ids.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import type { PreviousScheduleFailure } from "./lib/schedule_failing.ts";
import {
  detectScheduleFailures,
  type ScheduleFailureDetectDeps,
  type ScheduleFailureDetectResult,
} from "./lib/schedule_failure_detect.ts";
import { withCallTimeout } from "./lib/self_update_support.ts";
import { readStopAll, sdkStopAllReadIo } from "./lib/stop_all.ts";
import {
  STOP_ALL_ACTIVE_NOTICE_KIND,
  STOP_ALL_NOTICE_RESOLVER,
  syncStopAllNotice,
} from "./lib/stop_all_notice.ts";
import type { FailureRecord, NoticeRecord } from "./lib/types.ts";

/**
 * 全停止の通知の同期の上限(ミリ秒)。DBの書き込みと、Discordの送信を含む。
 * 超えても検出の結果は変えず、死活監視は叩く。
 * 内側の各段の上限(3秒、3秒、5秒)の合計より長くし、DBの読み書きの分を残す。
 * 検出の後の処理は、この15秒、URLの読み取りの5秒、死活監視の10秒で、最長30秒である。
 * scriptの`timeout`(60秒)の中で、検出そのものに時間を残すための値である。
 */
const STOP_ALL_NOTICE_SYNC_TIMEOUT_MS = 15_000;

/** 死活監視のURLを読む上限(ミリ秒)。超えたら、その回は叩かずに警告のログを残す。 */
const HEARTBEAT_URL_READ_TIMEOUT_MS = 5_000;

/** 配線が使う入出力。テストでは偽物に差し替える。 */
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

/** 検出が使う依存を、入出力から組み立てる。 */
export function buildDetectDeps(
  io: DetectScheduleFailuresIo,
  log: Logger,
): ScheduleFailureDetectDeps {
  return {
    workspace: io.workspace,
    now: () => Date.now(),
    listCompletedJobs: io.listCompletedJobs,
    getCompletedJobResult: io.getCompletedJobResult,
    getJob: io.getJob,
    listRecordedJobIds: io.listRecordedJobIds,
    getLatestFailure: io.getLatestFailure,
    recordFailure: io.recordFailure,
    addNotice: io.addNotice,
    sendJobFailed: async (failure) => {
      const webhookUrl = await io.getWebhookUrl();
      if (webhookUrl.length === 0) {
        return;
      }
      await io.notify(webhookUrl, {
        kind: "job_failed",
        instance_name: await io.getInstanceName(),
        flow_path: failure.flowPath,
        job_id: failure.jobId,
        error: failure.error,
      });
    },
    log,
  };
}

/** 検出が成功した後の処理の入出力。テストでは偽物に差し替える。 */
export type AfterDetectionIo = {
  /** 全停止の通知を変数に合わせる。 */
  readonly syncStopAllNotice: () => Promise<unknown>;
  /** 死活監視のURL。変数が無いと確かめられたときだけ`null`を返す。 */
  readonly getHeartbeatUrl: () => Promise<string | null>;
  readonly pingHeartbeat: (url: string) => Promise<HeartbeatResult>;
};

/**
 * 検出が成功した後に、全停止の通知を変数に合わせ、外部の死活監視を叩く。
 * 検出が例外で終わった回は呼ばれないので、叩かれない。
 * 失敗は警告のログだけにし、検出の結果に影響させない。URLはログに載せない。
 */
export async function afterDetection(
  io: AfterDetectionIo,
  log: Logger,
): Promise<void> {
  try {
    await io.syncStopAllNotice();
  } catch (err) {
    log.warn("could not sync the stop-all notice", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
  let url: string | null;
  try {
    url = await io.getHeartbeatUrl();
  } catch (err) {
    log.warn("could not read the heartbeat url", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return;
  }
  if (url === null) return;
  const result = await io.pingHeartbeat(url);
  if (result.kind === "rejected" || result.kind === "failed") {
    log.warn("heartbeat ping failed", {
      kind: result.kind,
      reason: result.reason,
    });
  }
}

export async function main(): Promise<ScheduleFailureDetectResult> {
  const log = logger("detect_schedule_failures");
  const workspace = wmillDefault.getWorkspace();
  const result = await detectScheduleFailures(
    buildDetectDeps(
      {
        workspace,
        listCompletedJobs: (query) => wmill.JobService.listCompletedJobs(query),
        getCompletedJobResult: (id) =>
          wmill.JobService.getCompletedJobResult({ workspace, id }),
        getJob: (id) => wmill.JobService.getJob({ workspace, id }),
        listRecordedJobIds: (jobIds) =>
          listRecordedScheduleFailureJobIds(jobIds),
        getLatestFailure: (flowPath) => getLatestScheduleFailure(flowPath),
        recordFailure: (record, jobIds) =>
          recordFailure(record, undefined, jobIds),
        addNotice: (record) => addNoticeUnlessUnresolved(record),
        getInstanceName: async () =>
          (
            await loadConfig(() =>
              wmill.getResource("f/factory/factory_config"),
            )
          ).instance_name,
        getWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
        notify: (webhookUrl, event) => notify(webhookUrl, event, { log }),
      },
      log,
    ),
  );
  await afterDetection(
    {
      syncStopAllNotice: () =>
        withCallTimeout(
          "sync stop-all notice",
          () =>
            syncStopAllNotice({
              read: () => readStopAll(sdkStopAllReadIo()),
              listUnresolved: () =>
                listUnresolvedNoticesByKind(STOP_ALL_ACTIVE_NOTICE_KIND),
              addNotice: (record) => addNoticeUnlessUnresolved(record),
              // 空の接頭辞は、本文によらず、この種類の未解決をすべて解決する。
              resolveActive: () =>
                resolveUnresolvedNoticesByPrefix(
                  STOP_ALL_ACTIVE_NOTICE_KIND,
                  "",
                  STOP_ALL_NOTICE_RESOLVER,
                ),
              readWebhookUrl: () =>
                wmill.getVariable("f/factory/discord_webhook_url"),
              notify: (webhookUrl: string, event: NotifyEvent) =>
                notifyBestEffort(webhookUrl, event, log),
              instanceName: async () =>
                (
                  await loadConfig(() =>
                    wmill.getResource("f/factory/factory_config"),
                  )
                ).instance_name,
              log,
            }),
          STOP_ALL_NOTICE_SYNC_TIMEOUT_MS,
        ),
      getHeartbeatUrl: () =>
        withCallTimeout(
          "read heartbeat url",
          () =>
            readVariableOrNull(
              () => wmill.getVariable("f/factory/heartbeat_url"),
              () =>
                wmill.VariableService.existsVariable({
                  workspace,
                  path: "f/factory/heartbeat_url",
                }),
            ),
          HEARTBEAT_URL_READ_TIMEOUT_MS,
        ),
      pingHeartbeat: (url) => pingHeartbeat(url, fetch),
    },
    log,
  );
  return result;
}
