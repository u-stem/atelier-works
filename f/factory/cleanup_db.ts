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
// Deleting a work item's requirements-doc directory (`doc_dirs_deleted`) is
// best-effort filesystem cleanup, not itself a DB sweep: it runs after
// `deleteTerminalWorkItemsBefore` succeeds, using the `{id, owner, repo,
// issue_number}` refs that call already returns for the rows it deleted
// (`lib/cleanup_db_support.ts`'s `docDirsFor`). A failure here (or the DB
// delete never running at all) is logged and noticed the same way as the
// other sweeps, and never blocks the rest of this job.

import * as wmill from "windmill-client@1.817.0";
import {
  type CleanupCounts,
  computeRetentionCutoffs,
  docDirsFor,
  summarizeCleanup,
} from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  type DeletedWorkItemRef,
  deleteDeploymentsBefore,
  deleteJobFailuresBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  insertCleanupRun,
} from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { REQUIREMENTS_BASE_DIR } from "./lib/requirements_template.ts";
import { removeEmptyDir, removePath } from "./lib/workspace.ts";

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Deletes terminal work items past `cutoff`. The approval_requests rows the
 * delete cascades away are counted inside the same statement (see
 * `deleteTerminalWorkItemsBefore`), so the two numbers always describe the
 * same set of rows. `deleted` (the per-item owner/repo/issue_number refs)
 * is what `cleanupDocDirs` below uses to find each item's requirements-doc
 * directory — empty when the delete itself failed, which correctly skips
 * that sweep too (there is nothing to delete `docDirsFor` could compute).
 */
async function cleanupWorkItems(
  cutoff: Date,
  log: Logger,
): Promise<
  Pick<CleanupCounts, "work_items_deleted" | "approval_requests_deleted"> & {
    readonly deleted: readonly DeletedWorkItemRef[];
  }
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
    return { work_items_deleted: 0, approval_requests_deleted: 0, deleted: [] };
  }
}

/**
 * Best-effort deletes each deleted work item's requirements-doc directory
 * (`docDirsFor`): the `wi-<id>` directory recursively, then its parent
 * `issue-<N>` directory only if that leaves it empty (a sibling work item
 * for the same issue may still have its own `wi-<id>` there). One failure
 * is logged and noticed but does not stop the rest — a stray directory left
 * behind is a disk-usage concern, not a correctness one, and the DB rows it
 * belonged to are already gone either way.
 */
async function cleanupDocDirs(
  deleted: readonly DeletedWorkItemRef[],
  log: Logger,
): Promise<number> {
  const dirs = docDirsFor(deleted, REQUIREMENTS_BASE_DIR);
  let deletedCount = 0;
  for (const { wiDir, issueDir } of dirs) {
    try {
      await removePath(wiDir);
      await removeEmptyDir(issueDir);
      deletedCount += 1;
    } catch (err) {
      const message = errorMessage(err);
      log.error("cleanup_db: failed to delete a requirements doc dir", {
        wiDir,
        error: message,
      });
      await addNotice({
        kind: "cleanup_db_failed",
        message: `要件定義ディレクトリの削除に失敗しました(${wiDir}): ${message}`,
      });
    }
  }
  return deletedCount;
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
  const docDirsDeleted = await cleanupDocDirs(workItems.deleted, log);
  const jobFailuresDeleted = await cleanupJobFailures(cutoffs.logsBefore, log);
  const deploymentsDeleted = await cleanupDeployments(cutoffs.logsBefore, log);
  const noticesDeleted = await cleanupNotices(cutoffs.logsBefore, log);

  const counts: CleanupCounts = {
    work_items_deleted: workItems.work_items_deleted,
    approval_requests_deleted: workItems.approval_requests_deleted,
    job_failures_deleted: jobFailuresDeleted,
    deployments_deleted: deploymentsDeleted,
    notices_deleted: noticesDeleted,
    doc_dirs_deleted: docDirsDeleted,
  };

  await recordRun(counts, log);
  log.info(summarizeCleanup(counts), counts);
  return counts;
}
