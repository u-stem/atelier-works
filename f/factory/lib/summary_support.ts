// 日次サマリー(`f/factory/notify_daily_summary.ts`)のための、
// 1日単位の集計クエリをまとめる。
// `db.ts`の`sumAgentCostSince`は「指定時刻から現在まで」の終端が開いた集計で、
// 日次サマリーに要る`[前日0時, 当日0時)`(JST)の閉じた範囲を扱えない。
// 前日の0時を渡すと、09:00 JSTの実行時点で当日早朝の実行まで数えてしまうため、
// ここで別に集計する。

import type { CleanupCounts } from "./cleanup_db_support.ts";
import { defaultSqlClient, type SqlClient, type SqlRow } from "./db.ts";
import { isNumber, isString } from "./types.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DayRange = {
  /** 範囲の始端(含む、UTCの時刻)。JSTの日付の0時に当たる。 */
  readonly start: Date;
  /** 範囲の終端(含まない、UTCの時刻)。翌日のJSTの0時に当たる。 */
  readonly end: Date;
  /** 範囲が表すJSTの日付(`YYYY-MM-DD`)。 */
  readonly label: string;
};

function formatDateUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * `now`が属するJSTの日の前日を、UTCの時刻の範囲`[start, end)`と
 * `YYYY-MM-DD`のラベルで返す(JSTはUTC+9固定、夏時間なし)。
 * 毎日09:00(Asia/Tokyo)に動く`notify_daily_summary.ts`の「前日」に当たる。
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

/**
 * `value`を数値にして返す。数値にできなければ例外を投げる。
 * Postgresの`count(*)`や`sum(...)`の結果は、シリアライズによって
 * JSの数値でも数字の文字列でも返りうるため、どちらも受け付ける。
 */
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
  /**
   * `range`内の`agent_runs`のうち、`exit_code`が`0`でない行の数。
   * 0以外で終わった行に加え、タイムアウトなどで`exit_code`がNULLの行も数える。
   */
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

/** `range`内の`factory.agent_runs`を集計し、件数・コスト・失敗数を返す。 */
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

/**
 * `range`内に判断された`factory.approval_requests`を集計し、承認数と差し戻し数を返す。
 * 指標の意味を要件定義の判断だけに保つため、`kind = 'requirements'`に絞る。
 * 同じテーブルにある`issue_proposal`の行は数えない。
 */
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
 * `range`内の`factory.cleanup_runs`の削除件数を合計して返す。
 * `cleanup_db.ts`は毎日03:30(Asia/Tokyo)に動くため、
 * 前日の範囲にはその朝の1回分だけが入る。
 * 範囲に行が無いとき(立ち上げ直後でまだ一度も動いていないときなど)は、
 * すべて0の`CleanupCounts`ではなく`null`を返す。
 * 日次サマリーのDiscord埋め込みで、
 * 「削除するものが無かった」と「記録が無い」を区別するため。
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
      coalesce(sum(info_notices_resolved), 0) AS info_notices_resolved,
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
    info_notices_resolved: parseNumericLike(
      row.info_notices_resolved,
      "info_notices_resolved",
    ),
    doc_dirs_deleted: parseNumericLike(
      row.doc_dirs_deleted,
      "doc_dirs_deleted",
    ),
  };
}
