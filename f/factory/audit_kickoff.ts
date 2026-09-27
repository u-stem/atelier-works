// audit_kickoff: entry point of 工程5. Runs weekly (audit_kickoff.schedule.yaml,
// Monday 09:30 Asia/Tokyo, args.source = "schedule") and from the Console's
// 今すぐ監査 button (source = "manual"). Decides the audit period, skips when
// there is nothing actionable / another audit is active / the period is
// empty / the daily budget is exceeded, otherwise inserts the audit work
// item and starts f/factory/audit. Skips are returned and logged only —
// never notified (nothing for a human to do).

import * as wmill from "windmill-client@1.817.0";
import { countActionableRecords } from "./lib/audit_evidence.ts";
import {
  type AuditKickoffSkip,
  assertAuditDays,
  buildAuditTitle,
  computeAuditPeriod,
  decideAuditKickoff,
  formatAuditPeriodLabel,
} from "./lib/audit_support.ts";
import { dailyBudgetStatus } from "./lib/claude.ts";
import { loadConfig } from "./lib/config.ts";
import {
  insertAuditWorkItem,
  latestAuditReport,
  listActiveAuditWorkItems,
  setFlowJobId,
} from "./lib/db.ts";
import { parseGitHubRepoUrl } from "./lib/github.ts";
import { logger } from "./lib/log.ts";

export type AuditKickoffResult =
  | {
      readonly skipped: true;
      readonly reason: AuditKickoffSkip | "concurrent_kickoff";
    }
  | {
      readonly skipped: false;
      readonly work_item_id: number;
      readonly flow_job_id: string;
      readonly period_label: string;
    };

export function parseKickoffSource(value: unknown): "schedule" | "manual" {
  return value === "schedule" ? "schedule" : "manual";
}

export async function main(
  days: number = 7,
  force: boolean = false,
  source: string = "manual",
): Promise<AuditKickoffResult> {
  assertAuditDays(days);
  const log = logger("audit_kickoff");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const { owner, repo } = parseGitHubRepoUrl(config.factory_repo);

  const active = await listActiveAuditWorkItems();
  const last = await latestAuditReport();
  const period = computeAuditPeriod({
    now: new Date(),
    lastPeriodEnd: last?.period_end ?? null,
    days,
    maxLookbackDays: config.max_lookback_days,
  });
  const counts =
    period !== null && !force ? await countActionableRecords(period) : null;
  const budget = await dailyBudgetStatus(config);
  const decision = decideAuditKickoff({
    activeAuditCount: active.length,
    period,
    force,
    counts,
    budgetExceeded: budget.exceeded,
  });
  if (decision.action === "skip") {
    log.info("audit skipped", { reason: decision.reason });
    return { skipped: true, reason: decision.reason };
  }

  const resolvedSource = parseKickoffSource(source);
  const workItemId = await insertAuditWorkItem({
    owner,
    repo,
    title: buildAuditTitle(decision.period),
    source: resolvedSource,
    claimed_by:
      resolvedSource === "manual" ? (process.env.WM_USERNAME ?? null) : null,
  });
  if (workItemId === null) {
    log.info("audit skipped", { reason: "concurrent_kickoff" });
    return { skipped: true, reason: "concurrent_kickoff" };
  }
  const flowJobId = await wmill.runFlowAsync("f/factory/audit", {
    work_item_id: workItemId,
    period_start: decision.period.start.toISOString(),
    period_end: decision.period.end.toISOString(),
    unaudited_gap_days: decision.period.unaudited_gap_days,
  });
  await setFlowJobId(workItemId, flowJobId);
  return {
    skipped: false,
    work_item_id: workItemId,
    flow_job_id: flowJobId,
    period_label: formatAuditPeriodLabel(
      decision.period.start,
      decision.period.end,
    ),
  };
}
