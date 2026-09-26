import React, { useMemo, useState } from "react";
import { BarChart, type BarChartDatum } from "../components/BarChart";
import {
  toAgentCostDailyRow,
  toApprovalStatsRow,
  toLeadTimeRow,
} from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";

const DAY_OPTIONS = [7, 30, 90] as const;

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function AnalyticsTab(): React.ReactElement {
  const [days, setDays] = useState<number>(30);

  const cost = useConsoleQuery("agent_cost_daily", toAgentCostDailyRow, {
    days,
    limit: 500,
  });
  const approvals = useConsoleQuery("approval_stats", toApprovalStatsRow, {
    days,
    limit: 500,
  });
  const leadTime = useConsoleQuery("lead_time", toLeadTimeRow, {
    days,
    limit: 1000,
  });

  const costByDay = useMemo(() => {
    const totals = new Map<string, { cost: number; count: number }>();
    for (const row of cost.rows) {
      const existing = totals.get(row.day) ?? { cost: 0, count: 0 };
      existing.cost += row.total_cost_usd ?? 0;
      existing.count += row.run_count;
      totals.set(row.day, existing);
    }
    return Array.from(totals.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [cost.rows]);

  const costChartData: BarChartDatum[] = costByDay.map(([day, totals]) => ({
    label: formatDay(day),
    value: Math.round(totals.cost * 100) / 100,
  }));
  const countChartData: BarChartDatum[] = costByDay.map(([day, totals]) => ({
    label: formatDay(day),
    value: totals.count,
  }));

  const approvalRate = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const row of approvals.rows) {
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
  }, [approvals.rows]);

  const rejectionChartData: BarChartDatum[] = useMemo(() => {
    const totals = new Map<number, number>();
    for (const row of approvals.rows) {
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
      .map(([attempt, count]) => ({
        label: `attempt ${attempt}`,
        value: count,
      }));
  }, [approvals.rows]);

  const leadTimeChartData: BarChartDatum[] = useMemo(() => {
    const totals = new Map<string, { sum: number; count: number }>();
    for (const row of leadTime.rows) {
      const existing = totals.get(row.status) ?? { sum: 0, count: 0 };
      existing.sum += row.lead_time_seconds;
      existing.count += 1;
      totals.set(row.status, existing);
    }
    return Array.from(totals.entries())
      .map(([status, { sum, count }]) => ({
        label: status,
        value: Math.round((sum / count / 3600) * 10) / 10,
      }))
      .sort((a, b) => b.value - a.value);
  }, [leadTime.rows]);

  const loading = cost.loading || approvals.loading || leadTime.loading;

  return (
    <div className="tab analytics-tab">
      <div className="tab-toolbar">
        <h2>分析</h2>
        <label className="field-inline">
          集計期間
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                直近{option}日
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && <p>読み込み中...</p>}
      {cost.error !== null && <p className="error-banner">{cost.error}</p>}
      {approvals.error !== null && (
        <p className="error-banner">{approvals.error}</p>
      )}
      {leadTime.error !== null && (
        <p className="error-banner">{leadTime.error}</p>
      )}

      <section>
        <h3>日別コスト(USD)</h3>
        <BarChart
          data={costChartData}
          formatValue={(value) => `$${value.toFixed(2)}`}
        />
      </section>
      <section>
        <h3>日別実行件数</h3>
        <BarChart data={countChartData} />
      </section>
      <section>
        <h3>一発承認率</h3>
        <p className="headline-number">
          {approvalRate === null ? "データなし" : `${approvalRate.toFixed(1)}%`}
        </p>
      </section>
      <section>
        <h3>差し戻し分布(attempt 別の却下件数)</h3>
        <BarChart data={rejectionChartData} />
      </section>
      <section>
        <h3>ステータス別平均リードタイム(時間)</h3>
        <BarChart
          data={leadTimeChartData}
          formatValue={(value) => `${value}h`}
        />
      </section>
    </div>
  );
}
