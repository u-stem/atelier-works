// Query helpers backing f/factory/notify_daily_summary.ts (spec-cycle2.md
// §3 M5 "notify_discord.ts ... 前日の agent_runs 集計").
//
// db.ts's `sumAgentCostSince(sinceIso)` was considered as a replacement for
// this file's cost aggregation, but doesn't fit: it's open-ended ("cost
// since `sinceIso`, up to now" — built for the daily-budget check against
// factory_config.daily_budget_usd), whereas a daily summary needs a closed
// `[yesterday 00:00 JST, today 00:00 JST)` window. Calling it with
// yesterday's start would double-count today's early-morning runs once the
// 09:00 JST schedule fires. It also has no equivalent for run_count,
// failure_count, or the approvals table at all. So the day-range
// aggregations stay here — db.ts (owned by the concurrent M4/M5 lib work)
// has no bounded day-range query, only per-row insert/select helpers plus
// that one open-ended sum. Uses the same injected `SqlClient` (db.ts) as
// every other lib module, so it is testable with the same fake-sql-client
// pattern (tests/lib/db.test.ts) and never hits a real database.

import type { CleanupCounts } from "./cleanup_db_support.ts";
import { defaultSqlClient, type SqlClient, type SqlRow } from "./db.ts";
import { isNumber, isString } from "./types.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DayRange = {
  /** Inclusive start instant (real UTC), i.e. the JST calendar day's 00:00. */
  readonly start: Date;
  /** Exclusive end instant (real UTC), i.e. the next JST calendar day's 00:00. */
  readonly end: Date;
  /** The JST calendar date this range covers, as `YYYY-MM-DD`. */
  readonly label: string;
};

function formatDateUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The JST ("Asia/Tokyo", fixed UTC+9, no DST) calendar day immediately
 * before `now`'s JST calendar day, as a `[start, end)` real-UTC instant
 * range plus a `YYYY-MM-DD` label — what notify_daily_summary.ts (a 09:00
 * Asia/Tokyo daily schedule) means by "yesterday".
 */
export function computeYesterdayRangeJst(now: Date): DayRange {
  const jstShifted = new Date(now.getTime() + JST_OFFSET_MS);
  const todayJstMidnightUtcMs = Date.UTC(
    jstShifted.getUTCFullYear(),
    jstShifted.getUTCMonth(),
    jstShifted.getUTCDate(),
  );
  const yesterdayJstMidnightUtcMs = todayJstMidnightUtcMs - DAY_MS;
  return {
    start: new Date(yesterdayJstMidnightUtcMs - JST_OFFSET_MS),
    end: new Date(todayJstMidnightUtcMs - JST_OFFSET_MS),
    label: formatDateUtc(new Date(yesterdayJstMidnightUtcMs)),
  };
}

/** Postgres `count(*)` / `sum(...)` results may come back as a JS number or
 * a numeric string depending on serialization (same caveat as db.ts's
 * `parseId`), so this accepts either. */
function parseNumericLike(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`summary_support: row field "${field}" is not numeric`);
}

export type AgentRunSummary = {
  readonly run_count: number;
  readonly total_cost_usd: number;
  /** agent_runs rows in `range` whose `exit_code` is not exactly `0`
   * (covers both a non-zero exit and a NULL exit_code, e.g. a timeout that
   * never produced one). */
  readonly failure_count: number;
};

function toAgentRunSummary(row: SqlRow | undefined): AgentRunSummary {
  if (row === undefined) {
    return { run_count: 0, total_cost_usd: 0, failure_count: 0 };
  }
  return {
    run_count: parseNumericLike(row.run_count, "run_count"),
    total_cost_usd: parseNumericLike(row.total_cost_usd, "total_cost_usd"),
    failure_count: parseNumericLike(row.failure_count, "failure_count"),
  };
}

/** Aggregates factory.agent_runs over `range` (spec-cycle2.md §3
 * "件数、コスト、失敗数"). */
export async function getAgentRunSummary(
  range: DayRange,
  sql: SqlClient = defaultSqlClient,
): Promise<AgentRunSummary> {
  const rows = await sql`
    SELECT
      count(*) AS run_count,
      coalesce(sum(cost_usd), 0) AS total_cost_usd,
      count(*) FILTER (WHERE exit_code IS DISTINCT FROM 0) AS failure_count
    FROM factory.agent_runs
    WHERE created_at >= ${range.start.toISOString()}
      AND created_at < ${range.end.toISOString()}
  `.fetch();
  return toAgentRunSummary(rows[0]);
}

export type ApprovalSummary = {
  readonly approved_count: number;
  readonly rejected_count: number;
};

function toApprovalSummary(row: SqlRow | undefined): ApprovalSummary {
  if (row === undefined) {
    return { approved_count: 0, rejected_count: 0 };
  }
  return {
    approved_count: parseNumericLike(row.approved_count, "approved_count"),
    rejected_count: parseNumericLike(row.rejected_count, "rejected_count"),
  };
}

/** Aggregates factory.approval_requests over `range` (spec-cycle2.md §3
 * "承認 / 差し戻し数"). Reads the generalized approval_requests table
 * (migrations/datatable/main/20260927120000_approval_requests.up.sql, which
 * backfills factory.approvals' history) rather than factory.approvals
 * itself. Restricted to kind = 'requirements' so the KPI keeps its
 * original meaning (requirement-draft decisions only; issue_proposal rows
 * live in the same table but are not counted here) — that table is retained for its pre-migration history only and
 * stops receiving new writes once callers switch over in a follow-up PR. */
export async function getApprovalSummary(
  range: DayRange,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalSummary> {
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE status = 'approved') AS approved_count,
      count(*) FILTER (WHERE status = 'rejected') AS rejected_count
    FROM factory.approval_requests
    WHERE kind = 'requirements'
      AND decided_at >= ${range.start.toISOString()}
      AND decided_at < ${range.end.toISOString()}
  `.fetch();
  return toApprovalSummary(rows[0]);
}

/**
 * Sums factory.cleanup_runs rows over `range` (cleanup_db.ts, a 03:30
 * Asia/Tokyo daily schedule, so a "yesterday" range's window always covers
 * exactly the one run from that morning). Placed here rather than db.ts —
 * same rationale as getAgentRunSummary/getApprovalSummary above: a bounded
 * day-range aggregation, not a per-row insert/select. Returns `null` when
 * no row falls in `range` (e.g. the schedule hasn't run yet on a
 * freshly-bootstrapped instance) rather than an all-zero CleanupCounts, so
 * notify_daily_summary.ts's Discord embed can distinguish "nothing to
 * clean up" from "no record at all".
 */
export async function getCleanupSummary(
  range: DayRange,
  sql: SqlClient = defaultSqlClient,
): Promise<CleanupCounts | null> {
  const rows = await sql`
    SELECT
      count(*) AS run_count,
      coalesce(sum(work_items_deleted), 0) AS work_items_deleted,
      coalesce(sum(approval_requests_deleted), 0) AS approval_requests_deleted,
      coalesce(sum(job_failures_deleted), 0) AS job_failures_deleted,
      coalesce(sum(deployments_deleted), 0) AS deployments_deleted,
      coalesce(sum(notices_deleted), 0) AS notices_deleted,
      coalesce(sum(doc_dirs_deleted), 0) AS doc_dirs_deleted
    FROM factory.cleanup_runs
    WHERE ran_at >= ${range.start.toISOString()}
      AND ran_at < ${range.end.toISOString()}
  `.fetch();
  const row = rows[0];
  if (row === undefined || parseNumericLike(row.run_count, "run_count") === 0) {
    return null;
  }
  return {
    work_items_deleted: parseNumericLike(
      row.work_items_deleted,
      "work_items_deleted",
    ),
    approval_requests_deleted: parseNumericLike(
      row.approval_requests_deleted,
      "approval_requests_deleted",
    ),
    job_failures_deleted: parseNumericLike(
      row.job_failures_deleted,
      "job_failures_deleted",
    ),
    deployments_deleted: parseNumericLike(
      row.deployments_deleted,
      "deployments_deleted",
    ),
    notices_deleted: parseNumericLike(row.notices_deleted, "notices_deleted"),
    doc_dirs_deleted: parseNumericLike(
      row.doc_dirs_deleted,
      "doc_dirs_deleted",
    ),
  };
}
