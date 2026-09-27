// Pure decision/formatting logic for cleanup_db.ts (DB retention cleanup,
// 2026-09-27 addition). No I/O -- see that script for wiring (db.ts calls,
// config loading, per-step error handling, and the actual filesystem
// deletes docDirsFor's paths point at).

import type { DeletedWorkItemRef } from "./db.ts";
import { assertGitHubName, type FactoryConfig } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionCutoffs = {
  /** Terminal-status work_items (and everything cascading from them:
   * requirement_drafts, approvals, agent_runs, approval_requests, ...)
   * updated_at at or before this instant are deleted. */
  readonly workItemsBefore: Date;
  /** job_failures / deployments / resolved notices rows whose own timestamp
   * column is at or before this instant are deleted independently of
   * work_items. */
  readonly logsBefore: Date;
};

/**
 * Computes the two retention cutoffs cleanup_db.ts sweeps against, `now`
 * minus each configured retention window (config.retention_work_items_days
 * / config.retention_logs_days).
 */
export function computeRetentionCutoffs(
  now: Date,
  config: Pick<
    FactoryConfig,
    "retention_work_items_days" | "retention_logs_days"
  >,
): RetentionCutoffs {
  return {
    workItemsBefore: new Date(
      now.getTime() - config.retention_work_items_days * DAY_MS,
    ),
    logsBefore: new Date(now.getTime() - config.retention_logs_days * DAY_MS),
  };
}

/** One cleanup_db.ts run's delete counts -- mirrors
 * migrations/datatable/main/20260927130000_cleanup_runs.up.sql's columns
 * (minus `id` / `ran_at`, which db.ts's insertCleanupRun fills in). */
export type CleanupCounts = {
  readonly work_items_deleted: number;
  readonly approval_requests_deleted: number;
  readonly job_failures_deleted: number;
  readonly deployments_deleted: number;
  readonly notices_deleted: number;
  /** Requirement-definition doc dirs (see docDirsFor) deleted alongside a
   * deleted work item. */
  readonly doc_dirs_deleted: number;
};

/**
 * A one-line Japanese summary of `counts`, for both the cleanup_db.ts job
 * log and the daily_summary Discord embed's "DB 掃除" field. Intentionally
 * omits approval_requests_deleted (a side effect of the work_items delete
 * cascading, not a sweep of its own) and doc_dirs_deleted (a filesystem
 * side effect of the same work_items delete, not a DB sweep of its own) --
 * the four counts shown are each an independent sweep the operator may
 * care about individually.
 */
export function summarizeCleanup(counts: CleanupCounts): string {
  return (
    `work item ${String(counts.work_items_deleted)}件、` +
    `失敗記録 ${String(counts.job_failures_deleted)}件、` +
    `デプロイ記録 ${String(counts.deployments_deleted)}件、` +
    `通知 ${String(counts.notices_deleted)}件を削除しました`
  );
}

// ---------------------------------------------------------------------------
// Requirements-doc directory cleanup (cleanup_db.ts, 2026-09-27 file-per-
// diagram redesign). Pure path computation only -- cleanup_db.ts does the
// actual filesystem deletes (best-effort, via lib/workspace.ts's
// removePath / removeEmptyDir).
// ---------------------------------------------------------------------------

export type DocDirsToDelete = {
  /** The deleted work item's own requirements doc dir, covering every
   * attempt (`<base>/<owner>/<repo>/issue-<N>/wi-<id>`) -- deleted
   * recursively. */
  readonly wiDir: string;
  /** Its parent `issue-<N>` directory, which cleanup_db.ts should also
   * remove but only if it is left empty (a sibling work item for the same
   * issue may still have its own `wi-<id>` directory under it). */
  readonly issueDir: string;
};

/**
 * Computes the requirements doc dir(s) to delete for each deleted work item
 * (`db.ts`'s `deleteTerminalWorkItemsBefore` return value), skipping items
 * with no `issue_number` (a `pr`-kind work item never had a requirements
 * doc dir in the first place). Mirrors
 * `lib/requirements_template.ts`'s `buildRequirementsDocDir` path scheme up
 * to the `wi-<id>` segment (this deletes every attempt at once, so it does
 * not go one level deeper to a specific `attempt-<k>`).
 */
export function docDirsFor(
  items: readonly DeletedWorkItemRef[],
  base: string,
): DocDirsToDelete[] {
  const result: DocDirsToDelete[] = [];
  for (const item of items) {
    if (item.issue_number === null) continue;
    assertGitHubName(item.owner);
    assertGitHubName(item.repo);
    const issueDir = `${base}/${item.owner}/${item.repo}/issue-${item.issue_number}`;
    result.push({ wiDir: `${issueDir}/wi-${item.id}`, issueDir });
  }
  return result;
}
