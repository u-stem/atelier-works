// `f/factory/`のすべてのスケジュールの`on_failure`ハンドラ。
// 失敗を`job_failures`に記録し、Discordに`job_failed`を通知する。
// 同じスケジュールの直近3回の実行が続けて失敗していれば、要対応のnoticeも残す。
//
// Windmillは`on_failure`ハンドラを決まった特殊引数で呼ぶ。引数名
// (`path`・`is_flow`・`schedule_path`・`job_id`・`error`)はWindmillの
// 文書にある規約に合わせたが、このworkerで実際の失敗に対して確かめてはいない。
// そのため引数はすべて省略可能にし、欠けたり名前が変わったりしても
// このハンドラ自身は例外を投げない。デプロイ先で実際にスケジュールが
// 失敗したら引数の形を確かめ、違っていれば引数と型ガードを直す。

import wmillDefault, * as wmill from "windmill-client";
import { loadConfig } from "./lib/config.ts";
import { addNoticeUnlessUnresolved, recordFailure } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { flagFailingSchedule } from "./lib/schedule_failing.ts";
import { isRecord, isString } from "./lib/types.ts";

function errorMessage(error: unknown): string {
  if (isRecord(error) && isString(error.message)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function main(
  path?: string,
  is_flow?: boolean,
  schedule_path?: string,
  job_id?: string,
  error?: unknown,
): Promise<void> {
  const log = logger("on_error_schedule");
  const message = maskSecrets(errorMessage(error));
  const flowPath = path ?? schedule_path ?? "unknown";
  const resolvedJobId = job_id ?? "unknown";

  log.error("schedule failed", {
    path,
    is_flow,
    schedule_path,
    job_id: resolvedJobId,
    error: message,
  });

  try {
    await recordFailure({
      work_item_id: null,
      flow_path: flowPath,
      job_id: resolvedJobId,
      step: null,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }

  try {
    const config = await loadConfig(() =>
      wmill.getResource("f/factory/factory_config"),
    );
    const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
    if (webhookUrl.length > 0) {
      await notify(webhookUrl, {
        kind: "job_failed",
        instance_name: config.instance_name,
        flow_path: flowPath,
        job_id: resolvedJobId,
        error: message,
      });
    }
  } catch (notifyErr) {
    log.error("failed to send discord notification", {
      error: maskSecrets(
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      ),
    });
  }

  // 直近の実行が続けて失敗しているスケジュールは、Discordの通知を見落としても拾えるよう、
  // 要対応のnoticeにも残す。既存の記録とDiscordの通知より後ろに置き、これらを遅らせない。
  await flagFailingSchedule(flowPath, {
    listRecentRuns: (path, count) =>
      wmill.JobService.listCompletedJobs({
        workspace: wmillDefault.getWorkspace(),
        scriptPathExact: path,
        orderDesc: true,
        perPage: count,
      }),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    log,
  });
}
