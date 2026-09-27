// Pure decision/formatting logic for cleanup_db.ts (DB retention cleanup,
// 2026-09-27 addition). No I/O -- see that script for wiring (db.ts calls,
// config loading, per-step error handling).

import type { FactoryConfig } from "./types.ts";

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
  /** Requirement-definition worktree directories deleted. Always 0 for
   * now -- that sweep is added in a follow-up PR (see cleanup_db.ts). */
  readonly doc_dirs_deleted: number;
};

/**
 * A one-line Japanese summary of `counts`, for both the cleanup_db.ts job
 * log and the daily_summary Discord embed's "DB 掃除" field. Intentionally
 * omits approval_requests_deleted (a side effect of the work_items delete
 * cascading, not a sweep of its own) and doc_dirs_deleted (always 0 for
 * now) -- the four counts shown are each an independent sweep the operator
 * may care about individually.
 */
export function summarizeCleanup(counts: CleanupCounts): string {
  return (
    `work item ${String(counts.work_items_deleted)}件、` +
    `失敗記録 ${String(counts.job_failures_deleted)}件、` +
    `デプロイ記録 ${String(counts.deployments_deleted)}件、` +
    `通知 ${String(counts.notices_deleted)}件を削除しました`
  );
}
