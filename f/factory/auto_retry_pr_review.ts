// GitHubの一時的な失敗で止まったPRレビューを、自動で再開するscript。
// 5分ごとに実行する。候補の選び方、再開の遷移、回数の上限は`./lib/pr_review_retry.ts`と
// `./lib/db.ts`にあり、このファイルは入出力をつなぐだけ。
// 状態の交換は、止まった理由と回数を条件にした比較交換なので、人が先に`retry_work_item`で再開していたり、
// 二重に起動したりしても、同じ作業項目を二度起動しない。ラベルは付け直さない。
// 失敗の通知は、この巡回が引き受ける前提で控えている。そのため、候補を取得できなければ
// 例外を投げてスケジュールの失敗にし、待ちを過ぎても再開されない作業項目と、
// 自動の再開を使い切った作業項目は、人に知らせる。通知は届いたときだけ記録するので、
// 届かなければ次の巡回で送り直す(最大で巡回の間隔、5分の遅れがある)。
// 配線は`buildRetryDeps`に切り出し、入出力(`AutoRetryIo`)を差し替えて検査できるようにしている。
import * as wmill from "windmill-client@1.817.0";
import {
  AUTO_RETRY_LIST_LIMIT,
  AUTO_RETRY_NOTE_PREFIX,
  type AutoRetryResult,
} from "./lib/auto_retry.ts";
import { loadConfig } from "./lib/config.ts";
import {
  listTransientReviewCandidates,
  recordTransientStall,
  restartTransientPrReview,
  setFlowJobIdIfUnset,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import { readJobState } from "./lib/job_state.ts";
import { type Logger, logger } from "./lib/log.ts";
import {
  notifyStalledTransientReviews,
  retryTransientPrReviews,
  type StalledTransientDeps,
  TRANSIENT_STALL_GRACE_SECONDS,
  type TransientReviewDeps,
  transientReviewNotice,
  transientReviewQuery,
} from "./lib/pr_review_retry.ts";

export type AutoRetryPrReviewResult = AutoRetryResult & {
  readonly stalled_notified: number;
};

/** 配線が使う入出力。テストでは偽物に差し替える。 */
export type AutoRetryIo = {
  readonly listTransientReviewCandidates: typeof listTransientReviewCandidates;
  readonly restartTransientPrReview: typeof restartTransientPrReview;
  readonly recordTransientStall: typeof recordTransientStall;
  readonly setFlowJobIdIfUnset: typeof setFlowJobIdIfUnset;
  readonly updateStatusIfLeaseHolder: typeof updateStatusIfLeaseHolder;
  /** 記録済みのflowジョブが終わっているか。動いているか状態を読めなければ`false`を返す。 */
  readonly isFlowJobFinished: (flowJobId: string | null) => Promise<boolean>;
  readonly runFlowAsync: (
    flowPath: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly getWebhookUrl: () => Promise<string>;
  readonly notifyBestEffort: typeof notifyBestEffort;
};

/** 再開と見送りの通知に渡す依存を、入出力から組み立てる。 */
export function buildRetryDeps(
  io: AutoRetryIo,
  instanceName: string,
  log: Logger,
): {
  readonly retry: TransientReviewDeps;
  readonly stalled: StalledTransientDeps;
} {
  const query = transientReviewQuery();
  return {
    retry: {
      pageSize: AUTO_RETRY_LIST_LIMIT,
      listCandidates: (afterId) =>
        io.listTransientReviewCandidates({
          ...query,
          limit: AUTO_RETRY_LIST_LIMIT,
          afterId,
        }),
      isFlowJobFinished: io.isFlowJobFinished,
      restart: (candidate) =>
        io.restartTransientPrReview({
          ...query,
          id: candidate.id,
          note: `${AUTO_RETRY_NOTE_PREFIX}restarted from failed`,
        }),
      launchFlow: (flowPath, args) => io.runFlowAsync(flowPath, args),
      recordFlowJobId: (id, jobId) => io.setFlowJobIdIfUnset(id, jobId),
      // 再開の状態交換が空にした`flow_job_id`を、リースの保持者として照合する。
      // `failed`へ戻すので、再開の候補に戻り、使い切れば巡回が人に知らせる。
      rollBack: (candidate, reason) =>
        io.updateStatusIfLeaseHolder(
          candidate.id,
          "reviewing",
          "failed",
          null,
          reason,
        ),
      log,
    },
    stalled: {
      pageSize: AUTO_RETRY_LIST_LIMIT,
      listStalled: (afterId) =>
        io.listTransientReviewCandidates({
          ...query,
          limit: AUTO_RETRY_LIST_LIMIT,
          afterId,
          extraGraceSeconds: TRANSIENT_STALL_GRACE_SECONDS,
          unnotifiedOnly: true,
          includeExhausted: true,
        }),
      // 届いたときだけ記録を残すので、配信に失敗した作業項目は次の巡回でもう一度送る。
      notify: async (candidate) => {
        const delivery = await io.notifyBestEffort(
          await io.getWebhookUrl(),
          transientReviewNotice({ instanceName, candidate }),
          log,
        );
        return delivery.status;
      },
      recordStall: (candidate) =>
        io.recordTransientStall({
          stallNotePrefix: query.stallNotePrefix,
          id: candidate.id,
        }),
      log,
    },
  };
}

/**
 * 再開し、続けて見送りと使い切りを人に知らせる。
 * 再開で例外が出ても、通知を先に済ませてから投げ直す。
 */
export async function runAutoRetryPrReview(
  io: AutoRetryIo,
  instanceName: string,
  log: Logger,
): Promise<AutoRetryPrReviewResult> {
  const deps = buildRetryDeps(io, instanceName, log);
  let retryError: unknown = null;
  let result: AutoRetryResult = { restarted: 0, skipped: 0, failed: 0 };
  try {
    result = await retryTransientPrReviews(deps.retry);
  } catch (err) {
    retryError = err;
  }
  const stalledNotified = await notifyStalledTransientReviews(deps.stalled);
  if (retryError !== null) throw retryError;
  return { ...result, stalled_notified: stalledNotified };
}

export async function main(): Promise<AutoRetryPrReviewResult> {
  const log = logger("auto_retry_pr_review");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const result = await runAutoRetryPrReview(
    {
      listTransientReviewCandidates,
      restartTransientPrReview,
      recordTransientStall,
      setFlowJobIdIfUnset,
      updateStatusIfLeaseHolder,
      isFlowJobFinished: async (flowJobId) => {
        const job = await readJobState(
          (id) =>
            wmill.JobService.getJob({
              workspace: process.env.WM_WORKSPACE ?? "",
              id,
              noLogs: true,
              noCode: true,
            }),
          flowJobId,
          (failure) =>
            log.warn("flow job state could not be read", {
              flow_job_id: flowJobId,
              ...failure,
            }),
        );
        return job.state !== "running" && job.state !== "unknown";
      },
      runFlowAsync: (flowPath, args) => wmill.runFlowAsync(flowPath, args),
      getWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
      notifyBestEffort,
    },
    config.instance_name,
    log,
  );
  log.info("pr_review auto retry finished", { ...result });
  return result;
}
