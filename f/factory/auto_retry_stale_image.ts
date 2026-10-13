// イメージが古くて止まった作業項目を、原因が直った後に再開するscript。
// 自己更新(`self_update`)が、イメージが古いことを知らせる通知を自動で解決したときに起動する。
// 候補の選び方、再開先、再開の回数の上限は`./lib/auto_retry.ts`にあり、このファイルは入出力をつなぐだけ。
// 状態の交換は、止まった理由を条件にした比較と交換なので、人が先に`retry_work_item`で再開していたり、
// 二重に起動したりしても、同じ作業項目を二度起動しない。
import * as wmill from "windmill-client@1.817.0";
import {
  AUTO_RETRY_LIST_LIMIT,
  AUTO_RETRY_MAX_RESTARTS,
  AUTO_RETRY_NOTE_PREFIX,
  type AutoRetryResult,
  retryStaleImageItems,
} from "./lib/auto_retry.ts";
import { AUTO_RETRY_REASON_PREFIXES } from "./lib/auto_retry_reasons.ts";
import { loadConfig } from "./lib/config.ts";
import {
  latestRequirementsApproval,
  listAutoRetryCandidates,
  restartStoppedWorkItem,
  setFlowJobId,
  setFlowJobIdIfUnset,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import {
  HOST_ACTION_NOTICE_KIND,
  HOST_ACTION_RESOLVER,
  STALE_IMAGE_NOTICE_MARKER,
} from "./lib/host_action.ts";
import { isRequirementsApprovedForAttempt } from "./lib/implement_support.ts";
import { logger } from "./lib/log.ts";
import { readJobState } from "./lib/poll_support.ts";

export async function main(): Promise<AutoRetryResult> {
  const log = logger("auto_retry_stale_image");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const result = await retryStaleImageItems({
    implementEnabled: config.implement_enabled,
    listCandidates: () =>
      listAutoRetryCandidates({
        reasonPrefixes: AUTO_RETRY_REASON_PREFIXES,
        noticeKind: HOST_ACTION_NOTICE_KIND,
        noticeMarker: STALE_IMAGE_NOTICE_MARKER,
        resolvedBy: HOST_ACTION_RESOLVER,
        notePrefix: AUTO_RETRY_NOTE_PREFIX,
        maxRestarts: AUTO_RETRY_MAX_RESTARTS,
        limit: AUTO_RETRY_LIST_LIMIT,
      }),
    isImplementReady: async (candidate) =>
      isRequirementsApprovedForAttempt(
        await latestRequirementsApproval(candidate.id),
        candidate.attempt,
      ),
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
    restart: (candidate, plan) =>
      restartStoppedWorkItem({
        id: candidate.id,
        expectedFrom: candidate.status,
        to: plan.toStatus,
        reasonPrefixes: AUTO_RETRY_REASON_PREFIXES,
        clearFlowJobId: plan.leased,
        notePrefix: AUTO_RETRY_NOTE_PREFIX,
        maxRestarts: AUTO_RETRY_MAX_RESTARTS,
        noticeKind: HOST_ACTION_NOTICE_KIND,
        noticeMarker: STALE_IMAGE_NOTICE_MARKER,
        resolvedBy: HOST_ACTION_RESOLVER,
        note: `${AUTO_RETRY_NOTE_PREFIX}restarted from ${candidate.status}`,
      }),
    launchFlow: (flowPath, args) => wmill.runFlowAsync(flowPath, args),
    recordFlowJobId: async (id, jobId, leased) => {
      if (leased) return setFlowJobIdIfUnset(id, jobId);
      await setFlowJobId(id, jobId);
      return true;
    },
    rollBack: (candidate, plan, reason) =>
      updateStatusIfLeaseHolder(
        candidate.id,
        plan.toStatus,
        "needs_human",
        plan.leased ? null : candidate.flow_job_id,
        reason,
      ),
    log,
  });
  log.info("auto retry finished", { ...result });
  return result;
}
