// 分析の画面が読む3つのviewの取得。定期には取り直さない。
// 取得から60秒を過ぎた値は、画面に戻ったときと開き直したときに取り直す。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type AgentCostDailyRow,
  type ApprovalStatsRow,
  isAgentCostDailyRows,
  isApprovalStatsRows,
  isLeadTimeRows,
  type LeadTimeRow,
} from "./guards/analytics.ts";
import type { Guard } from "./guards/primitives.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/**
 * 1回の取得で受け取る行数の上限。backendが受け付ける最大にする。
 * 超えた分は、新しい順に並べた末尾(古い日)から切れる。
 */
export const ANALYTICS_ROW_LIMIT = 2000;

/** 取得した値を新しいとみなす間隔。履歴を日ごとに集めた値で、開いている間に変わる量は小さい。 */
const ANALYTICS_STALE_MS = 60_000;

type AnalyticsView = "agent_cost_daily" | "approval_stats" | "lead_time";

/** 分析のキャッシュのキー。期間ごとに別のキャッシュにし、切り替えたときに別の期間の値を出さない。 */
export function analyticsQueryKey(
  view: AnalyticsView,
  days: number,
): readonly ["console", "analytics", AnalyticsView, number] {
  return ["console", "analytics", view, days];
}

async function fetchRows<T>(
  view: AnalyticsView,
  days: number,
  guard: Guard<T[]>,
  options: RunScriptOptions,
): Promise<T[]> {
  const result = await runScript(
    "console_query",
    { view, days, limit: ANALYTICS_ROW_LIMIT },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!guard(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 直近`days`日のClaudeの実行の集計を取る。失敗は`ApiFailure`で投げる。 */
export function fetchAgentCostDaily(
  days: number,
  options: RunScriptOptions = {},
): Promise<AgentCostDailyRow[]> {
  return fetchRows("agent_cost_daily", days, isAgentCostDailyRows, options);
}

/** 直近`days`日の承認の判断の集計を取る。失敗は`ApiFailure`で投げる。 */
export function fetchApprovalStats(
  days: number,
  options: RunScriptOptions = {},
): Promise<ApprovalStatsRow[]> {
  return fetchRows("approval_stats", days, isApprovalStatsRows, options);
}

/** 直近`days`日に終端になった作業項目のリードタイムを取る。失敗は`ApiFailure`で投げる。 */
export function fetchLeadTime(
  days: number,
  options: RunScriptOptions = {},
): Promise<LeadTimeRow[]> {
  return fetchRows("lead_time", days, isLeadTimeRows, options);
}

export function useAgentCostDaily(
  days: number,
): UseQueryResult<AgentCostDailyRow[], Error> {
  return useQuery({
    queryKey: analyticsQueryKey("agent_cost_daily", days),
    queryFn: ({ signal }) => fetchAgentCostDaily(days, { signal }),
    staleTime: ANALYTICS_STALE_MS,
  });
}

export function useApprovalStats(
  days: number,
): UseQueryResult<ApprovalStatsRow[], Error> {
  return useQuery({
    queryKey: analyticsQueryKey("approval_stats", days),
    queryFn: ({ signal }) => fetchApprovalStats(days, { signal }),
    staleTime: ANALYTICS_STALE_MS,
  });
}

export function useLeadTime(
  days: number,
): UseQueryResult<LeadTimeRow[], Error> {
  return useQuery({
    queryKey: analyticsQueryKey("lead_time", days),
    queryFn: ({ signal }) => fetchLeadTime(days, { signal }),
    staleTime: ANALYTICS_STALE_MS,
  });
}
