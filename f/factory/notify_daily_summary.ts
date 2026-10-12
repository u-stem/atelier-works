// 毎日09:00(JST)の日次要約の通知。前日の`agent_runs`(件数・費用・失敗)と
// 要件定義の`approval_requests`(承認・却下の件数)、
// defaultのworkerの負荷(`worker_samples`)を集計し、
// Discordに`daily_summary`のembedを投稿する。

import * as wmill from "windmill-client@1.817.0";
import type { CleanupCounts } from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import { type Logger, logger } from "./lib/log.ts";
import {
  computeYesterdayRangeJst,
  type DayRange,
  getAgentRunSummary,
  getApprovalSummary,
  getCleanupSummary,
  getWorkerLoadSummary,
} from "./lib/summary_support.ts";
import type {
  WorkerLoadReport,
  WorkerLoadSummary,
} from "./lib/worker_load_support.ts";

export type DailySummaryResult = {
  readonly day: string;
  readonly run_count: number;
  readonly total_cost_usd: number;
  readonly failure_count: number;
  readonly approved_count: number;
  readonly rejected_count: number;
  readonly cleanup: CleanupCounts | null;
  readonly worker_load: WorkerLoadReport;
};

/**
 * 前日のworkerの負荷の集計を読み、記録が無いことと読めなかったことを分けて返す。
 * 読めなかったときは、警告を残して`read_failed`を返す。
 * 負荷の記録は日次のまとめの補足なので、表が無いなどで読めなくても、
 * ほかの項目の通知を止めない。
 */
export async function readWorkerLoad(
  range: DayRange,
  fetchSummary: (range: DayRange) => Promise<WorkerLoadSummary | null>,
  log: Logger,
): Promise<WorkerLoadReport> {
  try {
    const summary = await fetchSummary(range);
    return summary === null
      ? { kind: "no_record" }
      : { kind: "summary", summary };
  } catch (error) {
    log.warn("worker load summary could not be read", {
      day: range.label,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "read_failed" };
  }
}

export async function main(): Promise<DailySummaryResult> {
  const log = logger("notify_daily_summary");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const range = computeYesterdayRangeJst(new Date());

  const [agentRuns, approvals, cleanup, workerLoad] = await Promise.all([
    getAgentRunSummary(range),
    getApprovalSummary(range),
    getCleanupSummary(range),
    readWorkerLoad(range, (r) => getWorkerLoadSummary(r), log),
  ]);

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  await notifyBestEffort(
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
      worker_load: workerLoad,
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
    worker_load: workerLoad,
  };
}
