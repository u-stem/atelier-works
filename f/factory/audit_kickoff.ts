// 監査工程の起点。毎週月曜09:30(JST)のスケジュール(`source = "schedule"`)と、
// Consoleの「今すぐ監査」ボタン(`source = "manual"`)から実行する。
// 監査期間を決め、対応すべき記録が無い・別の監査が進行中・期間が空・
// 日次予算を超えた場合は見送る。それ以外は監査のwork itemを挿入して
// `f/factory/audit`を起動する。
// 見送りは人がすることが無いので、戻り値とログに残すだけで通知しない。

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
