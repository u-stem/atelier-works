// 毎日09:00(JST)の日次要約の通知。1日分の`agent_runs`(件数・費用・失敗)と
// 要件定義の`approval_requests`(承認・却下の件数)、
// defaultのworkerの負荷(`worker_samples`)を集計し、
// Discordに`daily_summary`のembedを投稿する。
// 対象は、最後に要約を出した日の翌日から前日まで。
// ホストのスリープなどで予定が飛んだ日も、次の実行で古い順に出す。

import * as wmill from "windmill-client@1.817.0";
import type { CleanupCounts } from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  type NotifyBestEffortResult,
  notifyBestEffort,
} from "./lib/discord.ts";
import { type Logger, logger } from "./lib/log.ts";
import {
  type DayRange,
  getAgentRunSummary,
  getApprovalSummary,
  getCleanupSummary,
  getWorkerLoadSummary,
  parseSummaryState,
  planSummaryDays,
  type SummaryPlan,
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
 * その日のworkerの負荷の集計を読み、記録が無いことと読めなかったことを分けて返す。
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

/** 1日分を集計して通知した結果。通知が届いたかどうかも含む。 */
export type SummarizedDay = {
  readonly result: DailySummaryResult;
  readonly delivery: NotifyBestEffortResult;
};

export type CatchupResult = {
  /** 集計して通知まで進めた日。古い順。 */
  readonly days: readonly DailySummaryResult[];
  /** 上限を超えて飛ばした日数。 */
  readonly skipped_count: number;
  /** 通知が届かず、次の実行にやり直しを持ち越した日。無ければ`null`。 */
  readonly undelivered_day: string | null;
  /** `undelivered_day`の通知が届かなかった理由(秘密情報はマスク済み)。無ければ`null`。 */
  readonly undelivered_reason: string | null;
};

/** `summarizePendingDays`が使う外部の操作。テストでは差し替える。 */
export type CatchupDeps = {
  readonly summarizeDay: (range: DayRange) => Promise<SummarizedDay>;
  /** 最後に要約を出した日(`YYYY-MM-DD`)を保存する。 */
  readonly saveLastDay: (label: string) => Promise<void>;
  readonly log: Logger;
};

/**
 * `plan`の日を古い順に1日ずつ集計して通知し、そのたびに最後に出した日を保存する。
 * - 集計が例外になったら、その日で止まり、保存を進めない。次の実行が同じ日から再開する。
 * - 通知が届かなかった(`not_sent`)ら、その日で止まり、保存を進めない。
 *   進めると、届かなかった日の要約が二度と出ないため。
 *   ここでは例外にせず、`undelivered_day`に残して返す。例外にするのは`assertAllDelivered`である。
 * - webhookが未設定(`no_webhook`)なら、送る先が無いので保存を進める。
 */
export async function summarizePendingDays(
  plan: SummaryPlan,
  deps: CatchupDeps,
): Promise<CatchupResult> {
  if (plan.skipped_count > 0) {
    deps.log.warn("daily summaries skipped beyond the catch-up limit", {
      skipped_count: plan.skipped_count,
      first_day: plan.days[0]?.label ?? null,
    });
  }
  if (plan.future_last_day !== null) {
    deps.log.warn("last summary day is later than yesterday", {
      last_day: plan.future_last_day,
    });
  }
  const days: DailySummaryResult[] = [];
  for (const range of plan.days) {
    const { result, delivery } = await deps.summarizeDay(range);
    if (delivery.status === "not_sent") {
      return {
        days,
        skipped_count: plan.skipped_count,
        undelivered_day: range.label,
        undelivered_reason: delivery.reason,
      };
    }
    await deps.saveLastDay(range.label);
    days.push(result);
  }
  return {
    days,
    skipped_count: plan.skipped_count,
    undelivered_day: null,
    undelivered_reason: null,
  };
}

/**
 * 通知が届かなかった日があれば、例外を投げる。
 * 成功で終えると、Discordに届かない状態が続いても、ジョブのログの警告しか残らない。
 * 例外にすると、`on_error_schedule`が失敗を`job_failures`に記録するので、Consoleに残る。
 * 届いた日の保存は`summarizePendingDays`が済ませているので、次の実行は届かなかった日から再開する。
 */
export function assertAllDelivered(result: CatchupResult): CatchupResult {
  if (result.undelivered_day !== null) {
    throw new Error(
      `daily summary for ${result.undelivered_day} was not delivered: ${result.undelivered_reason ?? "unknown"}`,
    );
  }
  return result;
}

export async function main(): Promise<CatchupResult> {
  const log = logger("notify_daily_summary");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const lastDay = parseSummaryState(await wmill.getState());

  const result = await summarizePendingDays(
    planSummaryDays(lastDay, new Date()),
    {
      summarizeDay: async (range) => {
        const [agentRuns, approvals, cleanup, workerLoad] = await Promise.all([
          getAgentRunSummary(range),
          getApprovalSummary(range),
          getCleanupSummary(range),
          readWorkerLoad(range, (r) => getWorkerLoadSummary(r), log),
        ]);
        const delivery = await notifyBestEffort(
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
          result: {
            day: range.label,
            run_count: agentRuns.run_count,
            total_cost_usd: agentRuns.total_cost_usd,
            failure_count: agentRuns.failure_count,
            approved_count: approvals.approved_count,
            rejected_count: approvals.rejected_count,
            cleanup,
            worker_load: workerLoad,
          },
          delivery,
        };
      },
      saveLastDay: (label) => wmill.setState({ last_day: label }),
      log,
    },
  );
  return assertAllDelivered(result);
}
