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
  previousDayLabel,
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

/**
 * 追い付きで続けて送るときの、日と日の間の待ち(ミリ秒)。
 * 同じwebhookを使う他の通知を、Discordの送信回数の制限(429)で落とさないために、
 * 連続して送らず1秒あける。
 */
export const CATCHUP_INTERVAL_MS = 1000;

/** `summarizePendingDays`が使う外部の操作。テストでは差し替える。 */
export type CatchupDeps = {
  readonly summarizeDay: (range: DayRange) => Promise<SummarizedDay>;
  /** 最後に要約を出した日(`YYYY-MM-DD`)を保存する。 */
  readonly saveLastDay: (label: string) => Promise<void>;
  /** 指定のミリ秒だけ待つ。 */
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
};

/**
 * `plan`の日を古い順に1日ずつ集計して通知し、そのたびに最後に出した日を保存する。
 * 呼び出し側は、stateが`plan`の最初の日の前日を指す状態で渡す(`runDailySummary`が整える)。
 * stateは常に次に出す日の前日を指すので、止まった日をここで保存し直す必要は無い。
 * - 集計が例外になったら、その日で止まり、保存を進めない。次の実行が同じ日から再開する。
 * - 通知が届かなかった(`not_sent`)ら、その日で止まり、保存を進めない。
 *   進めると、その日の要約が二度と出ないため。次の実行が同じ日から再開する。
 *   ここでは例外にせず、`undelivered_day`に残して返す。例外にするのは`assertAllDelivered`である。
 * - webhookが未設定(`no_webhook`)なら、送る先が無いので保存を進める。
 * - 2通目以降は、直前の日を送った後に`CATCHUP_INTERVAL_MS`待ってから集計する。
 */
export async function summarizePendingDays(
  plan: SummaryPlan,
  deps: CatchupDeps,
): Promise<CatchupResult> {
  if (plan.skipped_count > 0) {
    deps.log.warn("daily summaries skipped beyond the catch-up limit", {
      skipped_count: plan.skipped_count,
      skipped_from: plan.skipped_from,
      skipped_to: plan.skipped_to,
    });
  }
  if (plan.future_last_day !== null) {
    deps.log.warn("last summary day is later than yesterday", {
      last_day: plan.future_last_day,
    });
  }
  const days: DailySummaryResult[] = [];
  let sentPrevious = false;
  for (const range of plan.days) {
    if (sentPrevious) {
      await deps.sleep(CATCHUP_INTERVAL_MS);
    }
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
    sentPrevious = delivery.status === "sent";
  }
  return {
    days,
    skipped_count: plan.skipped_count,
    undelivered_day: null,
    undelivered_reason: null,
  };
}

/**
 * 昨日より古い日の通知が届かなかったときだけ、例外を投げる。
 * 昨日より古い日は、前の実行で届かずに持ち越した日か、追い付きで遡って出す日である。
 * 届かなかった日が`yesterday`(その実行で最後に出すはずの日)のときは、
 * 次の実行が自動で出し直すので、人の操作は要らず、例外にしない。
 * 成功で終えると、Discordに届かない状態が続いても、ジョブのログの警告しか残らない。
 * 昨日より古い日まで届かないときは、例外にして`on_error_schedule`に失敗を`job_failures`へ記録させ、Consoleに残す。
 * stateは次に出す日の前日を指しているので、次の実行は届かなかった日から再開する。
 */
export function assertAllDelivered(
  result: CatchupResult,
  yesterday: string,
): CatchupResult {
  if (result.undelivered_day !== null && result.undelivered_day !== yesterday) {
    throw new Error(
      `daily summary for ${result.undelivered_day} was not delivered: ${result.undelivered_reason ?? "unknown"}`,
    );
  }
  return result;
}

/** `runDailySummary`が使う外部の操作。テストでは差し替える。 */
export type DailySummaryDeps = {
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: { last_day: string }) => Promise<void>;
  readonly summarizeDay: (range: DayRange) => Promise<SummarizedDay>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly log: Logger;
};

/**
 * stateを読み、出す日を決め、1日ずつ集計して通知し、そのたびにstateを保存する。
 * 送る前に、stateを計画の最初の日の前日にそろえて保存する。
 * stateが記録なし・読めない値・未来の日付でも、集計の例外や`not_sent`で止まった日から、
 * 次の実行が始まるようにするためである。
 * 有効な`last_day`がすでにその日なら、書かない。計画が空なら何もしない。
 * 7日の窓を超えるときは、窓の前日まで進み、飛ばした日は出さない。
 * そろえる保存が失敗したら、何も送らずに例外で終える。次の実行が同じ状態から再開する。
 * 昨日より古い日の通知が届かなければ、最後に例外を投げる(`assertAllDelivered`)。
 * 昨日の通知だけが届かないときは、警告を残して成功で返す。
 * `main`から例外が外れると、Discordに届かない状態が失敗として残らないので、ここにまとめてテストする。
 */
export async function runDailySummary(
  deps: DailySummaryDeps,
): Promise<CatchupResult> {
  const reading = parseSummaryState(await deps.getState());
  if (reading.unreadable) {
    deps.log.warn("summary state could not be read; treated as no record");
  }
  const plan = planSummaryDays(reading.last_day, deps.now());
  const [firstDay] = plan.days;
  if (firstDay !== undefined) {
    const expected = previousDayLabel(firstDay.label);
    if (reading.last_day !== expected) {
      await deps.setState({ last_day: expected });
    }
  }
  const result = await summarizePendingDays(plan, {
    summarizeDay: deps.summarizeDay,
    saveLastDay: (label) => deps.setState({ last_day: label }),
    sleep: deps.sleep,
    log: deps.log,
  });
  if (
    result.undelivered_day !== null &&
    result.undelivered_day === plan.yesterday
  ) {
    deps.log.warn(
      "yesterday's daily summary was not delivered; it will be retried in the next run",
      {
        day: result.undelivered_day,
        reason: result.undelivered_reason,
      },
    );
  }
  return assertAllDelivered(result, plan.yesterday);
}

export async function main(): Promise<CatchupResult> {
  const log = logger("notify_daily_summary");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  return runDailySummary({
    getState: () => wmill.getState(),
    setState: (state) => wmill.setState(state),
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log,
  });
}
