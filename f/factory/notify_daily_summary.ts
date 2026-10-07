// 毎日09:00(JST)の日次要約の通知。前日の`agent_runs`(件数・費用・失敗)と
// `approvals`(承認・却下の件数)を集計し、Discordに`daily_summary`の
// embedを投稿する。

import * as wmill from "windmill-client@1.817.0";
import type { CleanupCounts } from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import { type NotifyEvent, notify } from "./lib/discord.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  computeYesterdayRangeJst,
  getAgentRunSummary,
  getApprovalSummary,
  getCleanupSummary,
} from "./lib/summary_support.ts";

/**
 * Discordに通知する。webhookのURLが未設定なら何もしない。
 * 送信の失敗はマスクしてログに残すだけで、ジョブを失敗させない。
 * 通知の一時的な失敗で、成功した集計をスケジュール実行の失敗にしないため。
 */
async function notifySafe(
  webhookUrl: string,
  event: NotifyEvent,
  log: Logger,
): Promise<void> {
  if (webhookUrl.length === 0) return;
  try {
    await notify(webhookUrl, event);
  } catch (err) {
    log.warn("discord notify failed", { error: maskSecrets(String(err)) });
  }
}

export type DailySummaryResult = {
  readonly day: string;
  readonly run_count: number;
  readonly total_cost_usd: number;
  readonly failure_count: number;
  readonly approved_count: number;
  readonly rejected_count: number;
  readonly cleanup: CleanupCounts | null;
};

export async function main(): Promise<DailySummaryResult> {
  const log = logger("notify_daily_summary");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const range = computeYesterdayRangeJst(new Date());

  const [agentRuns, approvals, cleanup] = await Promise.all([
    getAgentRunSummary(range),
    getApprovalSummary(range),
    getCleanupSummary(range),
  ]);

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  await notifySafe(
    webhookUrl,
    {
      kind: "daily_summary",
      instance_name: config.instance_name,
      day: range.label,
      run_count: agentRuns.run_count,
      total_cost_usd: agentRuns.total_cost_usd,
      failure_count: agentRuns.failure_count,
      approved_count: approvals.approved_count,
      rejected_count: approvals.rejected_count,
      cleanup,
    },
    log,
  );

  return {
    day: range.label,
    run_count: agentRuns.run_count,
    total_cost_usd: agentRuns.total_cost_usd,
    failure_count: agentRuns.failure_count,
    approved_count: approvals.approved_count,
    rejected_count: approvals.rejected_count,
    cleanup,
  };
}
