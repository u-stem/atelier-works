// 監査工程の純粋関数(対象期間の計算、タイトル、起動するかの判定)をまとめる。
// 証跡の収集とMarkdown化は`./audit_evidence.ts`が担う。
// 監査を起動するかの判定に`SqlClient`や`maskSecrets`を要らなくするため、
// このファイルは依存を持たない小さなものに保つ。

import { jstMidnightTodayIso } from "./claude.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `date`が属するJSTの日付を`YYYY-MM-DD`で返す(UTC+9固定、夏時間なし)。 */
export function formatJstDate(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 監査期間`[start, end)`を人が読むラベルにして返す。
 * 期間に含まれる最後のJSTの日は`end`の前日なので、
 * 09-29 00:00に終わる期間は「〜09-28」と表示する。
 */
export function formatAuditPeriodLabel(start: Date, end: Date): string {
  return `${formatJstDate(start)}〜${formatJstDate(new Date(end.getTime() - DAY_MS))}`;
}

export type AuditPeriod = {
  readonly start: Date;
  readonly end: Date;
  /**
   * 前回のレポートの終端から今回の期間の始端までのうち、
   * `max_lookback_days`で切り捨てた日数(切り捨てが無ければ0)。
   */
  readonly unaudited_gap_days: number;
};

/**
 * 監査日数が正の整数でなければ(0、負、小数、NaN、Infinity)例外を投げる。
 * 起動時の`days`は手動実行のフォームからそのまま届くため、
 * 期間の計算に使う前に確かめる。
 */
export function assertAuditDays(days: number): void {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("audit_kickoff: days must be a positive integer");
  }
}

export function computeAuditPeriod(input: {
  readonly now: Date;
  readonly lastPeriodEnd: Date | null;
  readonly days: number;
  readonly maxLookbackDays: number;
}): AuditPeriod | null {
  assertAuditDays(input.days);
  const end = new Date(jstMidnightTodayIso(input.now));
  const floor = new Date(end.getTime() - input.maxLookbackDays * DAY_MS);
  let start: Date;
  let gapDays = 0;
  if (input.lastPeriodEnd === null) {
    const days = Math.min(input.days, input.maxLookbackDays);
    start = new Date(end.getTime() - days * DAY_MS);
  } else if (input.lastPeriodEnd.getTime() < floor.getTime()) {
    gapDays = Math.ceil(
      (floor.getTime() - input.lastPeriodEnd.getTime()) / DAY_MS,
    );
    start = floor;
  } else {
    start = input.lastPeriodEnd;
  }
  if (start.getTime() >= end.getTime()) {
    return null;
  }
  return { start, end, unaudited_gap_days: gapDays };
}

/**
 * フローの入力`period_start` / `period_end`(ISO文字列)と
 * `unaudited_gap_days`を`AuditPeriod`に変換する。
 * 日時を解釈できないときと、始端が終端以降のときは例外を投げる。
 */
export function parsePeriodArgs(
  start: string,
  end: string,
  gap: number,
): AuditPeriod {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    startDate >= endDate
  ) {
    throw new Error(`audit_support: invalid period ${start} .. ${end}`);
  }
  return {
    start: startDate,
    end: endDate,
    unaudited_gap_days: Math.max(0, Math.floor(gap)),
  };
}

export function buildAuditTitle(period: AuditPeriod): string {
  return `監査(${formatAuditPeriodLabel(period.start, period.end)})`;
}

export type ActionableCounts = {
  readonly job_failures: number;
  readonly decided_approvals: number;
  readonly agent_runs: number;
  readonly fix_rounds: number;
  readonly reviews: number;
  readonly deployments: number;
  readonly notices: number;
};

export function hasActionableRecords(counts: ActionableCounts): boolean {
  return Object.values(counts).some((count) => count > 0);
}

export type AuditKickoffSkip =
  | "audit_in_progress"
  | "empty_period"
  | "no_new_records"
  | "daily_budget_exceeded";

export type AuditKickoffDecision =
  | { readonly action: "skip"; readonly reason: AuditKickoffSkip }
  | { readonly action: "run"; readonly period: AuditPeriod };

export function decideAuditKickoff(input: {
  readonly activeAuditCount: number;
  readonly period: AuditPeriod | null;
  readonly force: boolean;
  /** 呼び出し側が件数を数えなかったとき(`force`)は`null`。その場合も予算は確かめる。 */
  readonly counts: ActionableCounts | null;
  readonly budgetExceeded: boolean;
}): AuditKickoffDecision {
  if (input.activeAuditCount > 0)
    return { action: "skip", reason: "audit_in_progress" };
  if (input.period === null) return { action: "skip", reason: "empty_period" };
  if (input.budgetExceeded)
    return { action: "skip", reason: "daily_budget_exceeded" };
  if (
    !input.force &&
    (input.counts === null || !hasActionableRecords(input.counts))
  ) {
    return { action: "skip", reason: "no_new_records" };
  }
  return { action: "run", period: input.period };
}
