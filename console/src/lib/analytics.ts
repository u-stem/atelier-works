// 分析の画面が表示する値の集計と整形。取得した行を、グラフと表に出す形にする。
// 日は、view側が日付で丸めた時刻(UTC)をそのまま使う。端末のタイムゾーンで読み替えると日がずれる。

import type {
  AgentCostDailyRow,
  ApprovalStatsRow,
  LeadTimeRow,
} from "../api/guards/analytics.ts";

/** 集計の期間(日)の選択肢。 */
export const ANALYTICS_PERIOD_DAYS = [7, 30, 90] as const;

export type AnalyticsPeriodDays = (typeof ANALYTICS_PERIOD_DAYS)[number];

export const DEFAULT_ANALYTICS_DAYS: AnalyticsPeriodDays = 30;

/** 1日分の費用と実行件数。`day`は`YYYY-MM-DD`(UTC)。 */
export type DailyTotal = {
  readonly day: string;
  readonly costUsd: number;
  readonly runCount: number;
};

export type AttemptRejections = {
  readonly attempt: number;
  readonly count: number;
};

export type StatusLeadTime = {
  readonly status: string;
  readonly averageHours: number;
  readonly count: number;
};

const SECONDS_PER_HOUR = 3600;

/** 取得した行数が上限に届いたか。届いたときは、古い分が切れている可能性がある。 */
export function hitsRowLimit(rowCount: number, limit: number): boolean {
  return rowCount >= limit;
}

/** ISO文字列の日付部分(UTC)。読めない値は元の文字列を返す。 */
function dayKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

/**
 * 段階とモデルをまとめて、日ごとの費用と実行件数にする。古い日から新しい日の順に並べる。
 * 費用が記録されていない行は0として足す。
 */
export function dailyTotals(rows: readonly AgentCostDailyRow[]): DailyTotal[] {
  const totals = new Map<string, { costUsd: number; runCount: number }>();
  for (const row of rows) {
    const key = dayKey(row.day);
    const existing = totals.get(key) ?? { costUsd: 0, runCount: 0 };
    existing.costUsd += row.total_cost_usd ?? 0;
    existing.runCount += row.run_count;
    totals.set(key, existing);
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, total]) => ({ day, ...total }));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`(UTC)を、その日の0時の時刻(ms)にする。日付として読めない値は`null`。 */
function dayStartMs(day: string): number | null {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * 実行の無い日を値0で補い、期間の全日を古い日から新しい日の順に並べる。
 * 期間は`now`の日(UTC)を最後とする`days`日で、棒の間隔を日数に比例させるために使う。
 * 期間の外の日の合計は捨てず、範囲を広げて含める。端末の時計とbackendの時刻はずれうるため。
 * 日付として読めない日は、並べる位置が決まらないので除く。
 * `truncated`が真のとき、取得した最も古い日より前は補わない。
 * 行数の上限で古い日が切れているので、その前を0で補うと、実際にはあった実行を無いものとして描くためである。
 */
export function fillDailyTotals(
  totals: readonly DailyTotal[],
  days: AnalyticsPeriodDays,
  now: Date,
  truncated = false,
): DailyTotal[] {
  const byTime = new Map<number, DailyTotal>();
  for (const total of totals) {
    const time = dayStartMs(total.day);
    if (time !== null) {
      byTime.set(time, total);
    }
  }
  const today = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const windowStart = today - (days - 1) * MS_PER_DAY;
  const fetched = [...byTime.keys()];
  const times = [windowStart, today, ...fetched];
  const first =
    truncated && fetched.length > 0 ? Math.min(...fetched) : Math.min(...times);
  const last = Math.max(...times);
  const filled: DailyTotal[] = [];
  for (let time = first; time <= last; time += MS_PER_DAY) {
    filled.push(
      byTime.get(time) ?? {
        day: new Date(time).toISOString().slice(0, 10),
        costUsd: 0,
        runCount: 0,
      },
    );
  }
  return filled;
}

/**
 * 1回目の判断のうち承認の割合(百分率)。
 * 承認か却下の判断が1件も無ければ、割り切れないので`null`を返す。
 */
export function firstTryApprovalRate(
  rows: readonly ApprovalStatsRow[],
): number | null {
  let approved = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.attempt !== 1) {
      continue;
    }
    if (row.decision === "approved") {
      approved += row.decision_count;
    }
    if (row.decision === "rejected") {
      rejected += row.decision_count;
    }
  }
  const total = approved + rejected;
  return total === 0 ? null : (approved / total) * 100;
}

/** 試行ごとの却下の件数。試行の小さい順に並べる。 */
export function rejectionsByAttempt(
  rows: readonly ApprovalStatsRow[],
): AttemptRejections[] {
  const totals = new Map<number, number>();
  for (const row of rows) {
    if (row.decision !== "rejected") {
      continue;
    }
    totals.set(
      row.attempt,
      (totals.get(row.attempt) ?? 0) + row.decision_count,
    );
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => a - b)
    .map(([attempt, count]) => ({ attempt, count }));
}

/** 終端の状態ごとの平均リードタイム(時間)と件数。平均の長い順に並べる。 */
export function leadTimeByStatus(
  rows: readonly LeadTimeRow[],
): StatusLeadTime[] {
  const totals = new Map<string, { seconds: number; count: number }>();
  for (const row of rows) {
    const existing = totals.get(row.status) ?? { seconds: 0, count: 0 };
    existing.seconds += row.lead_time_seconds;
    existing.count += 1;
    totals.set(row.status, existing);
  }
  return Array.from(totals.entries())
    .map(([status, { seconds, count }]) => ({
      status,
      averageHours: seconds / count / SECONDS_PER_HOUR,
      count,
    }))
    .sort(
      (a, b) =>
        b.averageHours - a.averageHours || a.status.localeCompare(b.status),
    );
}

/** グラフの横軸に出す「10/8」の形(UTC)。日付として読めない値は、そのまま返す。 */
export function formatMonthDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

/** 表に出す「2026-10-08」の形(UTC)。日付として読めない値は、そのまま返す。 */
export function formatIsoDate(iso: string): string {
  return dayKey(iso);
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 小数第1位までの時間。末尾の0は付けない。 */
export function formatHours(value: number): string {
  return `${Math.round(value * 10) / 10}h`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
