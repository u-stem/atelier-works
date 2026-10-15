// GitHubの一時的な失敗で止まったPRレビューを、自動で再開するscript。
// 5分ごとに実行する。候補の選び方、再開の遷移、回数の上限は`./lib/pr_review_retry.ts`と
// `./lib/db.ts`にあり、このファイルは入出力をつなぐだけ。
// 状態の交換は、止まった理由と回数を条件にした比較交換なので、人が先に`retry_work_item`で再開していたり、
// 二重に起動したりしても、同じ作業項目を二度起動しない。ラベルは付け直さない。
import * as wmill from "windmill-client@1.817.0";
import {
  AUTO_RETRY_LIST_LIMIT,
  AUTO_RETRY_MAX_RESTARTS,
  AUTO_RETRY_NOTE_PREFIX,
  type AutoRetryResult,
} from "./lib/auto_retry.ts";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "./lib/auto_retry_reasons.ts";
import { loadConfig } from "./lib/config.ts";
import {
  listTransientReviewCandidates,
  restartTransientPrReview,
  setFlowJobId,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import { logger } from "./lib/log.ts";
import { readJobState } from "./lib/poll_support.ts";
import {
  retryTransientPrReviews,
  TRANSIENT_RETRY_MIN_AGE_SECONDS,
} from "./lib/pr_review_retry.ts";
import { nextActionFor } from "./steps/pr_workflow_support.ts";

export async function main(): Promise<AutoRetryResult> {
  const log = logger("auto_retry_pr_review");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const query = {
    reasonPrefix: TRANSIENT_GITHUB_REASON_PREFIX,
    notePrefix: AUTO_RETRY_NOTE_PREFIX,
    maxRestarts: AUTO_RETRY_MAX_RESTARTS,
    minAgeSeconds: TRANSIENT_RETRY_MIN_AGE_SECONDS,
  };
  const result = await retryTransientPrReviews({
    listCandidates: () =>
      listTransientReviewCandidates({ ...query, limit: AUTO_RETRY_LIST_LIMIT }),
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
    restart: (candidate) =>
      restartTransientPrReview({
        ...query,
        id: candidate.id,
        note: `${AUTO_RETRY_NOTE_PREFIX}restarted from failed`,
      }),
    launchFlow: (flowPath, args) => wmill.runFlowAsync(flowPath, args),
    recordFlowJobId: (id, jobId) => setFlowJobId(id, jobId),
    rollBack: (candidate, reason) =>
      updateStatusIfLeaseHolder(
        candidate.id,
        "reviewing",
        "needs_human",
        candidate.flow_job_id,
        reason,
      ),
    notifyRollBack: async (candidate, reason) => {
      await notifyBestEffort(
        await wmill.getVariable("f/factory/discord_webhook_url"),
        {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner: candidate.owner,
          repo: candidate.repo,
          url: `https://github.com/${candidate.owner}/${candidate.repo}/pull/${String(candidate.pr_number)}`,
          reason,
          target: { kind: "pr", number: candidate.pr_number },
          next_action: nextActionFor(reason),
        },
        log,
      );
    },
    log,
  });
  log.info("pr_review auto retry finished", { ...result });
  return result;
}
