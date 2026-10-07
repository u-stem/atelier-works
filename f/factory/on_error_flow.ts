// Factoryのフローの`failure_module`から呼ぶ失敗ハンドラ。
// 失敗を`job_failures`に記録し、work itemを`failed`にして、
// Discordに`job_failed`を通知する。
//
// `failure_module`は`error`(`message`・`step_id`・`name`・`stack`)と、
// `input_transforms`で`flow_input`から渡した値を受け取る。
// `work_item_id`は`flow_input.work_item_id`から渡す前提で、
// 引数名と1対1に対応させる。`path`と`job_id`は`job_failures`の文脈として
// 受け取るが、渡さないフローもあるので省略できる。
//
// `pipeline_generate`の失敗も、自分で終了処理をせずここに集める。
// `retry_work_item`が行う状態やラベルの管理と干渉しないため。
//
// GitHubには成果物だけを載せ、運用上の通知(`failed`への遷移を含む)は
// DiscordとConsoleにだけ出す。そのため、work itemを`failed`にしても
// IssueやPRには何も投稿しない。ラベルにも触れない。どの種別のトリガー
// ラベル(Issueは`factory`、PRは`factory:review`・`factory:fix`)も
// 取得時に消費済みで、外すものも付けるものも無いため。
// 運用者に届くのは、DBの`failed`への遷移と、`main()`が必ず送る
// Discordの`job_failed`通知である。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { getWorkItem, recordFailure, updateStatusIfCurrent } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import {
  isRecord,
  isString,
  TERMINAL_WORK_ITEM_STATUSES,
  type WorkItem,
} from "./lib/types.ts";

function errorMessage(error: unknown): string {
  if (isRecord(error) && isString(error.message)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStepId(error: unknown): string | null {
  if (isRecord(error) && isString(error.step_id)) return error.step_id;
  return null;
}

/**
 * `recordFailure`に渡してよい`work_item_id`を返す。存在を確かめた行のidか、
 * `null`を返す。`item`は`requestedId`で引いた結果(存在しないか、
 * 指定が無ければ`null`)。
 * `job_failures.work_item_id`は外部キーなので、存在しないidをそのまま渡すと
 * `job_failures_work_item_id_fkey`に違反し、挿入が例外になって失敗の記録
 * そのものが失われる(例外は捕まえて警告ログに残すだけ)。
 * `null`を返したとき、呼び出し側は`requestedId`をエラー文に含めて残す。
 */
export function failureWorkItemRef(
  item: Pick<WorkItem, "id"> | null,
  requestedId: number | undefined,
): number | null {
  if (item === null || requestedId === undefined) return null;
  return item.id;
}

/**
 * この呼び出しがwork itemを`failed`にしてよいかを返す。
 * `rootJobId`はこの呼び出しのフローのルートジョブid(`WM_ROOT_FLOW_JOB_ID`)、
 * `workItemFlowJobId`は`setFlowJobId`でwork itemの行に最後に記録したジョブid。
 * 古いフローの`failure_module`が動く前に、却下・再生成、`retry_work_item`、
 * 経路の切り替えで新しいフローが起動していると、2つのidは一致しない。
 * ここで`failed`にすると、新しいフローのprepareのstepが終端状態を見て
 * 黙って処理を飛ばし、再生成が失われる。
 * どちらかのidが無い(まだ記録していない、フローの外で動いている)ときは、
 * 食い違う根拠が無いとみなして許可する。
 */
export function shouldMarkFailed(
  workItemFlowJobId: string | null,
  rootJobId: string | null,
): boolean {
  if (workItemFlowJobId === null || rootJobId === null) return true;
  return workItemFlowJobId === rootJobId;
}

export async function main(
  error: unknown,
  work_item_id?: number,
  path?: string,
  job_id?: string,
): Promise<void> {
  const log = logger("on_error_flow");
  const message = maskSecrets(errorMessage(error));
  const resolvedPath = path ?? "unknown";
  const rootJobId = process.env.WM_ROOT_FLOW_JOB_ID ?? null;
  const resolvedJobId =
    job_id ?? rootJobId ?? process.env.WM_JOB_ID ?? "unknown";

  log.error("flow failed", {
    work_item_id,
    path,
    job_id: resolvedJobId,
    error: message,
  });

  let item: WorkItem | null = null;
  if (work_item_id !== undefined) {
    try {
      item = await getWorkItem(work_item_id);
    } catch (fetchErr) {
      log.error("failed to fetch work item", {
        work_item_id,
        error: maskSecrets(
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        ),
      });
    }
  }

  const workItemRef = failureWorkItemRef(item, work_item_id);
  const recordedError =
    work_item_id !== undefined && workItemRef === null
      ? `${message} (work_item_id ${work_item_id}: no matching row)`
      : message;

  try {
    await recordFailure({
      work_item_id: workItemRef,
      flow_path: resolvedPath,
      job_id: resolvedJobId,
      step: errorStepId(error),
      error: recordedError,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }

  if (item !== null && !TERMINAL_WORK_ITEM_STATUSES.includes(item.status)) {
    try {
      if (!shouldMarkFailed(item.flow_job_id, rootJobId)) {
        log.warn(
          "on_error_flow: skipping status transition — work item's flow_job_id no longer matches this run (a newer run already replaced it)",
          {
            work_item_id,
            work_item_flow_job_id: item.flow_job_id,
            root_job_id: rootJobId,
          },
        );
      } else {
        // トリガーラベルは取得時に消費済みなので、外すラベルも付ける
        // 状態ラベルも無い。運用者にはDBの状態更新と、下のDiscordの
        // `job_failed`通知だけが届く。
        await updateStatusIfCurrent(item.id, item.status, "failed", message);
      }
    } catch (statusErr) {
      log.error("failed to mark work item failed", {
        work_item_id,
        error: maskSecrets(
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        ),
      });
    }
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
        flow_path: resolvedPath,
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
}
