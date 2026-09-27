// cleanup_db: every day at 03:30 Asia/Tokyo (see cleanup_db.schedule.yaml),
// deletes rows past their configured retention window from the `factory`
// schema, which otherwise grows without bound: terminal-status work items
// (and everything that cascades from them: requirement_drafts, approvals,
// agent_runs, approval_requests) past `config.retention_work_items_days`,
// and job_failures / deployments / resolved notices past
// `config.retention_logs_days`, each swept independently of work_items.
//
// Pure cutoff computation and summary formatting live in
// ./lib/cleanup_db_support.ts; this file is I/O wiring only. Each sweep is
// independent: one table's delete failing is logged (job log + a
// `factory.notices` row) and does not stop the rest from running. A
// genuine DB-connectivity failure surfaces naturally instead of being
// swallowed, since the `addNotice` call inside each catch block is itself
// unguarded — if the database is unreachable, that call fails too and
// propagates out of `main`, rather than the per-step try/catch silently
// returning an all-zero result.
//
// Deleting the requirements-generation worktree directory for an
// old/deleted work item (`doc_dirs_deleted`) is out of scope here — it is
// always 0 for now and added in a follow-up PR.

import * as wmill from "windmill-client@1.817.0";
import {
  type CleanupCounts,
  computeRetentionCutoffs,
  summarizeCleanup,
} from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  deleteDeploymentsBefore,
  deleteJobFailuresBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  insertCleanupRun,
} from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Deletes terminal work items past `cutoff`. The approval_requests rows the
 * delete cascades away are counted inside the same statement (see
 * `deleteTerminalWorkItemsBefore`), so the two numbers always describe the
 * same set of rows.
 */
async function cleanupWorkItems(
  cutoff: Date,
  log: Logger,
): Promise<
  Pick<CleanupCounts, "work_items_deleted" | "approval_requests_deleted">
> {
  try {
    return await deleteTerminalWorkItemsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete terminal work items", {
      error: message,
    });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `終端 work item の削除に失敗しました: ${message}`,
    });
    return { work_items_deleted: 0, approval_requests_deleted: 0 };
  }
}

async function cleanupJobFailures(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteJobFailuresBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete job_failures", { error: message });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `失敗記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

async function cleanupDeployments(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteDeploymentsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete deployments", { error: message });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `デプロイ記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

async function cleanupNotices(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteResolvedNoticesBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete resolved notices", {
      error: message,
    });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `通知の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/** Records this run in factory.cleanup_runs. A failure here is logged and
 * noticed the same as the sweeps above, but never fails the job — the
 * deletes themselves already succeeded (or were already individually
 * handled) by the time this runs. */
async function recordRun(counts: CleanupCounts, log: Logger): Promise<void> {
  try {
    await insertCleanupRun(counts);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to record cleanup_runs row", {
      error: message,
    });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `掃除結果の記録に失敗しました: ${message}`,
    });
  }
}

export async function main(): Promise<CleanupCounts> {
  const log = logger("cleanup_db");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const cutoffs = computeRetentionCutoffs(new Date(), config);

  const workItems = await cleanupWorkItems(cutoffs.workItemsBefore, log);
  const jobFailuresDeleted = await cleanupJobFailures(cutoffs.logsBefore, log);
  const deploymentsDeleted = await cleanupDeployments(cutoffs.logsBefore, log);
  const noticesDeleted = await cleanupNotices(cutoffs.logsBefore, log);

  const counts: CleanupCounts = {
    work_items_deleted: workItems.work_items_deleted,
    approval_requests_deleted: workItems.approval_requests_deleted,
    job_failures_deleted: jobFailuresDeleted,
    deployments_deleted: deploymentsDeleted,
    notices_deleted: noticesDeleted,
    // Requirement-definition worktree cleanup is added in a follow-up PR.
    doc_dirs_deleted: 0,
  };

  await recordRun(counts, log);
  log.info(summarizeCleanup(counts), counts);
  return counts;
}
