// 日次サマリー(`f/factory/notify_daily_summary.ts`)のための、
// 1日単位の集計クエリをまとめる。
// `db.ts`の`sumAgentCostSince`は「指定時刻から現在まで」の終端が開いた集計で、
// 日次サマリーに要る`[前日0時, 当日0時)`(JST)の閉じた範囲を扱えない。
// 前日の0時を渡すと、09:00 JSTの実行時点で当日早朝の実行まで数えてしまうため、
// ここで別に集計する。

import type { CleanupCounts } from "./cleanup_db_support.ts";
import { defaultSqlClient, type SqlClient, type SqlRow } from "./db.ts";
import { isNumber, isRecord, isString } from "./types.ts";
import {
  DAILY_GAP_THRESHOLD_SECONDS,
  DAILY_LAG_THRESHOLD_SECONDS,
  WORKER_SAMPLES_PER_DAY,
  type WorkerLoadSummary,
} from "./worker_load_support.ts";

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

/** JSTの日付の0時を「UTCの0時」として表した時刻(ミリ秒)から、その日の範囲を作る。 */
function dayRangeFromShiftedMidnight(shiftedMidnightMs: number): DayRange {
  return {
    start: new Date(shiftedMidnightMs - JST_OFFSET_MS),
    end: new Date(shiftedMidnightMs + DAY_MS - JST_OFFSET_MS),
    label: formatDateUtc(new Date(shiftedMidnightMs)),
  };
}

/** `now`が属するJSTの日の0時を、「UTCの0時」として表した時刻(ミリ秒)で返す。 */
function todayShiftedMidnightMs(now: Date): number {
  const jstShifted = new Date(now.getTime() + JST_OFFSET_MS);
  return Date.UTC(
    jstShifted.getUTCFullYear(),
    jstShifted.getUTCMonth(),
    jstShifted.getUTCDate(),
  );
}

/**
 * `now`が属するJSTの日の前日を、UTCの時刻の範囲`[start, end)`と
 * `YYYY-MM-DD`のラベルで返す(JSTはUTC+9固定、夏時間なし)。
 * 毎日09:00(Asia/Tokyo)に動く`notify_daily_summary.ts`の「前日」に当たる。
 */
export function computeYesterdayRangeJst(now: Date): DayRange {
  return dayRangeFromShiftedMidnight(todayShiftedMidnightMs(now) - DAY_MS);
}

const DAY_LABEL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD`を、その日のJSTの0時を「UTCの0時」として表した時刻(ミリ秒)にする。
 * 形式が違うときと、存在しない日付(2月30日など)は`null`を返す。
 */
function parseDayLabel(label: string): number | null {
  const match = DAY_LABEL_PATTERN.exec(label);
  if (match === null) {
    return null;
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatDateUtc(new Date(ms)) === label ? ms : null;
}

/** 一度の実行で遡って出す日数の上限。 */
export const MAX_CATCHUP_DAYS = 7;

/** stateを読んだ結果。`unreadable`は、値があるのに解釈できなかったことを表す。 */
export type SummaryStateReading = {
  /** 最後に要約を出した日。記録が無い、または読めないときは`null`。 */
  readonly last_day: string | null;
  /** 初回ではない値が入っていたのに、解釈できなかったとき`true`。呼び出し側が警告に残す。 */
  readonly unreadable: boolean;
};

/**
 * Windmillのstateに保存した、最後に要約を出した日(JSTの`YYYY-MM-DD`)を読む。
 * - 初回の空のstate(`null`、`undefined`、`last_day`の無いオブジェクト)は、記録なしとして`unreadable: false`で返す。
 * - 値があるのに形が違うもの(実在しない日付を含む)は、記録なしと同じに扱いつつ`unreadable: true`で返す。
 */
export function parseSummaryState(value: unknown): SummaryStateReading {
  if (value === null || value === undefined) {
    return { last_day: null, unreadable: false };
  }
  if (!isRecord(value)) {
    return { last_day: null, unreadable: true };
  }
  const lastDay = value.last_day;
  if (lastDay === undefined || lastDay === null) {
    return { last_day: null, unreadable: false };
  }
  return isString(lastDay) && parseDayLabel(lastDay) !== null
    ? { last_day: lastDay, unreadable: false }
    : { last_day: null, unreadable: true };
}

export type SummaryPlan = {
  /** 要約を出す日。古い順。 */
  readonly days: readonly DayRange[];
  /** 上限を超えたために出さずに飛ばす日数。 */
  readonly skipped_count: number;
  /**
   * 最後に出した日が前日より後(時計のずれなど)のとき、その日。
   * 記録なしと同じに扱って前日を出し、stateを上書きして直す。呼び出し側が警告に残す。
   */
  readonly future_last_day: string | null;
};

/**
 * 最後に要約を出した日`lastDay`の翌日から`now`の前日までを、古い順に並べる。
 * - `lastDay`が`null`(初回、または読めない値)のときは、前日だけを出し、過去を遡らない。
 * - `lastDay`が前日のときは、出す日が無い。
 * - `lastDay`が前日より後(時計のずれによる未来)のときは、記録なしと同じに前日だけを出し、
 *   `future_last_day`にその日を返す。放置すると、日付が追い付くまで要約が止まるため。
 * - 対象が`maxDays`を超えるときは、新しい方の`maxDays`日だけを出し、
 *   古い日は飛ばして`skipped_count`に数える。
 *   日次の要約は古い日ほど読まれにくく、長い停止の後に何通も続けて出さないため。
 */
export function planSummaryDays(
  lastDay: string | null,
  now: Date,
  maxDays: number = MAX_CATCHUP_DAYS,
): SummaryPlan {
  const yesterdayMs = todayShiftedMidnightMs(now) - DAY_MS;
  const parsedMs = lastDay === null ? null : parseDayLabel(lastDay);
  const isFuture = parsedMs !== null && parsedMs > yesterdayMs;
  const lastMs = isFuture ? null : parsedMs;
  const firstMs = lastMs === null ? yesterdayMs : lastMs + DAY_MS;
  if (firstMs > yesterdayMs) {
    return { days: [], skipped_count: 0, future_last_day: null };
  }
  const total = Math.round((yesterdayMs - firstMs) / DAY_MS) + 1;
  const skipped = Math.max(0, total - maxDays);
  const days: DayRange[] = [];
  for (let ms = firstMs + skipped * DAY_MS; ms <= yesterdayMs; ms += DAY_MS) {
    days.push(dayRangeFromShiftedMidnight(ms));
  }
  return {
    days,
    skipped_count: skipped,
    future_last_day: isFuture ? lastDay : null,
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

/** 日時を`Date`にして返す。`Date`でも日時の文字列でもなければ例外を投げる。 */
function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }
  if (isString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(
    `summary_support: row field "${field}" is not a valid timestamp`,
  );
}

/** `parseDate`と同じだが、NULLは`null`で返す。 */
function parseNullableDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : parseDate(value, field);
}

/** `parseNumericLike`と同じだが、NULL(集計に使える値が無かったこと)は`null`で返す。 */
function parseNullableNumeric(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : parseNumericLike(value, field);
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
    WHERE created_at >= ${range.start.toISOString()}::timestamptz
      AND created_at < ${range.end.toISOString()}::timestamptz
  `.fetch();
  return toAgentRunSummary(rows[0]);
}

/**
 * `range`内の`factory.worker_samples`を1回のクエリで集計し、workerの負荷のまとめを返す。
 * 範囲に行が無いとき(記録を始める前や、記録が止まっていた日)は、
 * すべて0の集計ではなく`null`を返す。
 * 日次サマリーのDiscord埋め込みで、「負荷が0だった」と「記録が無い」を区別するため。
 *
 * - `mem_oom`と`mem_oom_kill`は起動からの累積なので、値の読めた行だけを並べ、
 *   その隣り合う行の差を足す。列ごとに別の窓で並べるのは、
 *   片方がNULLの行をまたいでも、その間の増分を取りこぼさないためである。
 *   差が負なら累積が戻った(コンテナの再起動)ので、現在値を増分とする。
 *   範囲の最初の行の差は、範囲の始端の10分前まで読んだ直近の行との差で求める。
 *   差を1つも求められないときの合計はNULLで、「OOMなし」とは区別される。
 * - 空白は、`sampled_at`の間隔が`DAILY_GAP_THRESHOLD_SECONDS`を超えた回数である。
 *   隣り合う行の間隔に加えて、日の両端も数える。
 *   範囲の最初の行は、始端の10分前までの直近の行との間隔で、その行が無ければ始端との間隔で数える。
 *   最後の行は、終端との間隔で数える。夜間にまたぐ停止は、両端の空白として前日と当日に分かれて出る。
 *   長い1回の空白は、停止でも長いジョブによる枠の塞がりでも出るので、ここでは区別しない。
 *   最長の空白は、開始と終了の時刻も返す。
 * - 割合は行ごとに求めてから最大を取る。上限が読めない行は、メモリの割合に使わない。
 * - 集計は`(sampled_at)`の索引で範囲を絞る。
 */
export async function getWorkerLoadSummary(
  range: DayRange,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkerLoadSummary | null> {
  const rows = await sql`
    WITH base AS (
      SELECT
        id,
        sampled_at,
        sampled_at >= ${range.start.toISOString()}::timestamptz AS in_range,
        slots,
        running_jobs,
        lag_seconds,
        max_wait_seconds,
        mem_anon_bytes,
        mem_working_set_bytes,
        mem_limit_bytes,
        mem_oom,
        mem_oom_kill
      FROM factory.worker_samples
      WHERE sampled_at >= ${range.start.toISOString()}::timestamptz - interval '10 minutes'
        AND sampled_at < ${range.end.toISOString()}::timestamptz
    ),
    timed AS (
      SELECT
        *,
        coalesce(
          lag(sampled_at) OVER (ORDER BY sampled_at, id),
          ${range.start.toISOString()}::timestamptz
        ) AS gap_from
      FROM base
    ),
    gaps AS (
      SELECT gap_from, sampled_at AS gap_to FROM timed WHERE in_range
      UNION ALL
      SELECT max(sampled_at), ${range.end.toISOString()}::timestamptz
      FROM base
      WHERE in_range
      HAVING count(*) > 0
    ),
    long_gaps AS (
      SELECT gap_from, gap_to, extract(epoch FROM gap_to - gap_from) AS gap_seconds
      FROM gaps
      WHERE extract(epoch FROM gap_to - gap_from) > ${DAILY_GAP_THRESHOLD_SECONDS}
    ),
    oom AS (
      SELECT sampled_at, in_range, mem_oom AS current_value,
        lag(mem_oom) OVER (ORDER BY sampled_at, id) AS previous_value
      FROM base
      WHERE mem_oom IS NOT NULL
    ),
    oom_kill AS (
      SELECT sampled_at, in_range, mem_oom_kill AS current_value,
        lag(mem_oom_kill) OVER (ORDER BY sampled_at, id) AS previous_value
      FROM base
      WHERE mem_oom_kill IS NOT NULL
    )
    SELECT
      count(*) AS sample_count,
      max(lag_seconds) AS lag_max_seconds,
      count(*) FILTER (WHERE lag_seconds >= ${DAILY_LAG_THRESHOLD_SECONDS}) AS lag_over_count,
      coalesce(sum(lag_seconds) FILTER (WHERE lag_seconds >= ${DAILY_LAG_THRESHOLD_SECONDS}), 0) AS lag_over_total_seconds,
      (SELECT count(*) FROM long_gaps) AS gap_count,
      (SELECT max(gap_seconds) FROM long_gaps) AS gap_longest_seconds,
      (SELECT gap_from FROM long_gaps ORDER BY gap_seconds DESC, gap_from LIMIT 1) AS gap_longest_from,
      (SELECT gap_to FROM long_gaps ORDER BY gap_seconds DESC, gap_from LIMIT 1) AS gap_longest_to,
      max(running_jobs) AS running_jobs_max,
      max(slots) AS slots_max,
      max(mem_anon_bytes) AS mem_anon_max_bytes,
      max(mem_anon_bytes::float8 / mem_limit_bytes)
        FILTER (WHERE mem_limit_bytes > 0) AS mem_anon_max_ratio,
      max(mem_working_set_bytes) AS mem_working_set_max_bytes,
      (SELECT sum(CASE WHEN current_value < previous_value THEN current_value ELSE current_value - previous_value END)
        FROM oom WHERE in_range) AS mem_oom_increase,
      (SELECT sum(CASE WHEN current_value < previous_value THEN current_value ELSE current_value - previous_value END)
        FROM oom_kill WHERE in_range) AS mem_oom_kill_increase,
      max(max_wait_seconds) AS max_wait_max_seconds
    FROM timed
    WHERE in_range
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const sampleCount = parseNumericLike(row.sample_count, "sample_count");
  if (sampleCount === 0) {
    return null;
  }
  return {
    sample_count: sampleCount,
    expected_count: WORKER_SAMPLES_PER_DAY,
    lag_max_seconds: parseNullableNumeric(
      row.lag_max_seconds,
      "lag_max_seconds",
    ),
    lag_over_count: parseNumericLike(row.lag_over_count, "lag_over_count"),
    lag_over_total_seconds: parseNumericLike(
      row.lag_over_total_seconds,
      "lag_over_total_seconds",
    ),
    gap_count: parseNumericLike(row.gap_count, "gap_count"),
    gap_longest_seconds: parseNullableNumeric(
      row.gap_longest_seconds,
      "gap_longest_seconds",
    ),
    gap_longest_from: parseNullableDate(
      row.gap_longest_from,
      "gap_longest_from",
    ),
    gap_longest_to: parseNullableDate(row.gap_longest_to, "gap_longest_to"),
    running_jobs_max: parseNullableNumeric(
      row.running_jobs_max,
      "running_jobs_max",
    ),
    slots_max: parseNullableNumeric(row.slots_max, "slots_max"),
    mem_anon_max_bytes: parseNullableNumeric(
      row.mem_anon_max_bytes,
      "mem_anon_max_bytes",
    ),
    mem_anon_max_ratio: parseNullableNumeric(
      row.mem_anon_max_ratio,
      "mem_anon_max_ratio",
    ),
    mem_working_set_max_bytes: parseNullableNumeric(
      row.mem_working_set_max_bytes,
      "mem_working_set_max_bytes",
    ),
    mem_oom_increase: parseNullableNumeric(
      row.mem_oom_increase,
      "mem_oom_increase",
    ),
    mem_oom_kill_increase: parseNullableNumeric(
      row.mem_oom_kill_increase,
      "mem_oom_kill_increase",
    ),
    max_wait_max_seconds: parseNullableNumeric(
      row.max_wait_max_seconds,
      "max_wait_max_seconds",
    ),
  };
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
      AND decided_at >= ${range.start.toISOString()}::timestamptz
      AND decided_at < ${range.end.toISOString()}::timestamptz
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
      coalesce(sum(main_ci_runs_deleted), 0) AS main_ci_runs_deleted,
      coalesce(sum(worker_samples_deleted), 0) AS worker_samples_deleted,
      coalesce(sum(pr_ci_checks_deleted), 0) AS pr_ci_checks_deleted,
      coalesce(sum(doc_dirs_deleted), 0) AS doc_dirs_deleted
    FROM factory.cleanup_runs
    WHERE ran_at >= ${range.start.toISOString()}::timestamptz
      AND ran_at < ${range.end.toISOString()}::timestamptz
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
    main_ci_runs_deleted: parseNumericLike(
      row.main_ci_runs_deleted,
      "main_ci_runs_deleted",
    ),
    worker_samples_deleted: parseNumericLike(
      row.worker_samples_deleted,
      "worker_samples_deleted",
    ),
    pr_ci_checks_deleted: parseNumericLike(
      row.pr_ci_checks_deleted,
      "pr_ci_checks_deleted",
    ),
    doc_dirs_deleted: parseNumericLike(
      row.doc_dirs_deleted,
      "doc_dirs_deleted",
    ),
  };
}
