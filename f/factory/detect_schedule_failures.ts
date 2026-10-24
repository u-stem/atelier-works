// scheduleが起こしたジョブの失敗を、Windmillのジョブ履歴から拾って記録し、通知するscript。5分ごとに動く。
// このWindmillではscheduleの`on_failure`が呼ばれないので、失敗の入口はこのscriptだけである。
// 判定と記録は`./lib/schedule_failure_detect.ts`にあり、このファイルは入出力をつなぐだけ。
// tag `periodic`のworkerで動かす。defaultのworkerで動かすと、長いジョブ(implementは最長6時間)が枠を塞ぐ間、失敗の検知が止まるため。
// 読むsecretは通知先の`discord_webhook_url`だけである。
// 検出器が止まったことは、`default_worker_watch`が、このscriptの成功した実行の完了時刻から見つける。
// tag periodicを付けたscriptの境界は`tests/scripts/periodic_script_boundary.test.ts`が固定する。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getLatestScheduleFailure,
  listRecordedScheduleFailureJobIds,
  recordFailure,
} from "./lib/db.ts";
import { type NotifyEvent, notify } from "./lib/discord.ts";
import type { JobIds } from "./lib/job_ids.ts";
import { type Logger, logger } from "./lib/log.ts";
import type { PreviousScheduleFailure } from "./lib/schedule_failing.ts";
import {
  detectScheduleFailures,
  type ScheduleFailureDetectDeps,
  type ScheduleFailureDetectResult,
} from "./lib/schedule_failure_detect.ts";
import type { FailureRecord, NoticeRecord } from "./lib/types.ts";

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

export async function main(): Promise<ScheduleFailureDetectResult> {
  const log = logger("detect_schedule_failures");
  const workspace = wmillDefault.getWorkspace();
  return await detectScheduleFailures(
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
}
