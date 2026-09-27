// Pure helpers for 工程5 (audit): period math, title, and kickoff
// decisions. The evidence pack (collection + markdown rendering) lives in
// ./audit_evidence.ts, which imports AuditPeriod / ActionableCounts /
// formatAuditPeriodLabel from here — kept separate so this file stays small
// and dependency-free (no SqlClient/maskSecrets needed to decide "should an
// audit run?").

import { jstMidnightTodayIso } from "./claude.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of `date`'s JST calendar day (fixed UTC+9, no DST). */
export function formatJstDate(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Human label for a `[start, end)` audit period: the last *included* JST
 * day is `end - 1 day`, so a period ending 09-29 00:00 reads "〜09-28". */
export function formatAuditPeriodLabel(start: Date, end: Date): string {
  return `${formatJstDate(start)}〜${formatJstDate(new Date(end.getTime() - DAY_MS))}`;
}

export type AuditPeriod = {
  readonly start: Date;
  readonly end: Date;
  /** Days between the previous report's end and this period's start that
   * max_lookback_days cut off (0 when nothing was cut). */
  readonly unaudited_gap_days: number;
};

export function computeAuditPeriod(input: {
  readonly now: Date;
  readonly lastPeriodEnd: Date | null;
  readonly days: number;
  readonly maxLookbackDays: number;
}): AuditPeriod | null {
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

/** Parses the flow inputs `period_start` / `period_end` (ISO strings) and
 * `unaudited_gap_days` into an AuditPeriod; throws on an inverted or
 * unparsable range. */
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
  /** null when the caller skipped counting (force) — still needs budget. */
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
