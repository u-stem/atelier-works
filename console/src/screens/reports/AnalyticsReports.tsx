import { RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  ANALYTICS_ROW_LIMIT,
  useAgentCostDaily,
  useApprovalStats,
  useLeadTime,
} from "../../api/analyticsQueries.ts";
import type {
  AgentCostDailyRow,
  ApprovalStatsRow,
  LeadTimeRow,
} from "../../api/guards/analytics.ts";
import { BarChart } from "../../components/BarChart.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  ANALYTICS_PERIOD_DAYS,
  type AnalyticsPeriodDays,
  DEFAULT_ANALYTICS_DAYS,
  dailyTotals,
  fillDailyTotals,
  firstTryApprovalRate,
  formatHours,
  formatIsoDate,
  formatMonthDay,
  formatPercent,
  formatUsd,
  hitsRowLimit,
  leadTimeByStatus,
  rejectionsByAttempt,
} from "../../lib/analytics.ts";
import { cn } from "../../lib/cn.ts";
import { attemptRef, workItemStatusLabel } from "../../lib/labels.ts";
import { AnalyticsSection } from "./AnalyticsSection.tsx";

function formatCount(value: number): string {
  return value.toLocaleString("ja-JP");
}

function TruncationNote({ rowCount }: { rowCount: number }) {
  return hitsRowLimit(rowCount, ANALYTICS_ROW_LIMIT) ? (
    <p className="text-small text-warning">
      取得できる件数の上限({formatCount(ANALYTICS_ROW_LIMIT)}
      件)に届いたため、古い分が含まれていない可能性があります。期間を短くしてください。
    </p>
  ) : null;
}

function ChartBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-body font-medium">{title}</h4>
      {children}
    </div>
  );
}

function CostReport({
  rows,
  days,
}: {
  rows: readonly AgentCostDailyRow[];
  days: AnalyticsPeriodDays;
}) {
  const totals = dailyTotals(rows);
  // グラフは実行の無い日も0で並べ、間隔を日数に比例させる。表は実行のあった日だけを出す。
  // 行数が上限に届いたときは古い日が切れているので、取れた最古の日より前は補わない。
  const chartDays = fillDailyTotals(
    totals,
    days,
    new Date(),
    hitsRowLimit(rows.length, ANALYTICS_ROW_LIMIT),
  );
  const costData = chartDays.map((total) => ({
    key: total.day,
    label: formatMonthDay(total.day),
    value: total.costUsd,
  }));
  const countData = chartDays.map((total) => ({
    key: total.day,
    label: formatMonthDay(total.day),
    value: total.runCount,
  }));
  return (
    <>
      <TruncationNote rowCount={rows.length} />
      <ChartBlock title="日別コスト(USD・UTC)">
        <BarChart
          title="日別コスト(UTC)"
          data={costData}
          axis="sequence"
          formatValue={formatUsd}
        />
      </ChartBlock>
      <ChartBlock title="日別実行件数(UTC)">
        <BarChart
          title="日別実行件数(UTC)"
          data={countData}
          axis="sequence"
          formatValue={formatCount}
        />
      </ChartBlock>
      <DataTable
        caption="日別のコストと実行件数"
        columns={["日(UTC)", "コスト(USD)", "実行件数"]}
        rows={totals.map((total) => ({
          key: total.day,
          cells: [
            formatIsoDate(total.day),
            formatUsd(total.costUsd),
            formatCount(total.runCount),
          ],
        }))}
      />
    </>
  );
}

function ApprovalReport({ rows }: { rows: readonly ApprovalStatsRow[] }) {
  const rate = firstTryApprovalRate(rows);
  const rejections = rejectionsByAttempt(rows);
  return (
    <>
      <TruncationNote rowCount={rows.length} />
      <ChartBlock title="一発承認率">
        <p className="text-display font-semibold tabular-nums">
          {rate === null ? "データなし" : formatPercent(rate)}
        </p>
        <p className="text-small text-muted-foreground">
          最初の判断が承認だった割合です。
        </p>
      </ChartBlock>
      <ChartBlock title="差し戻し分布(試行ごとの却下件数)">
        {rejections.length === 0 ? (
          <p className="text-small text-muted-foreground">
            この期間に却下はありません。
          </p>
        ) : (
          <>
            <BarChart
              title="試行ごとの却下件数"
              axis="category"
              data={rejections.map((entry) => ({
                key: String(entry.attempt),
                label: attemptRef(entry.attempt),
                value: entry.count,
              }))}
              formatValue={formatCount}
            />
            <DataTable
              caption="試行ごとの却下件数"
              columns={["試行", "却下件数"]}
              rows={rejections.map((entry) => ({
                key: String(entry.attempt),
                cells: [attemptRef(entry.attempt), formatCount(entry.count)],
              }))}
            />
          </>
        )}
      </ChartBlock>
    </>
  );
}

function LeadTimeReport({ rows }: { rows: readonly LeadTimeRow[] }) {
  const byStatus = leadTimeByStatus(rows);
  return (
    <>
      <TruncationNote rowCount={rows.length} />
      <ChartBlock title="状態別の平均リードタイム(時間)">
        <BarChart
          title="状態別の平均リードタイム"
          axis="category"
          data={byStatus.map((entry) => ({
            key: entry.status,
            label: workItemStatusLabel(entry.status),
            value: entry.averageHours,
          }))}
          formatValue={formatHours}
        />
      </ChartBlock>
      <DataTable
        caption="状態別の平均リードタイムと件数"
        columns={["状態", "平均リードタイム", "件数"]}
        rows={byStatus.map((entry) => ({
          key: entry.status,
          cells: [
            workItemStatusLabel(entry.status),
            formatHours(entry.averageHours),
            formatCount(entry.count),
          ],
        }))}
      />
    </>
  );
}

/**
 * 分析。Claudeの実行のコスト、承認の統計、リードタイムを、期間を選んでグラフと表で出す。
 * 3つのviewは別々に取得し、区画ごとに取得中、失敗、空、値ありを出し分ける。
 * 画面の見出しや余白は持たず、置き場所は呼び出し側が決める。
 */
export function AnalyticsReports() {
  const [days, setDays] = useState<AnalyticsPeriodDays>(DEFAULT_ANALYTICS_DAYS);
  const cost = useAgentCostDaily(days);
  const approvals = useApprovalStats(days);
  const leadTime = useLeadTime(days);
  const isFetching =
    cost.isFetching || approvals.isFetching || leadTime.isFetching;

  return (
    <section aria-labelledby="analytics-heading">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 id="analytics-heading" className="text-title font-semibold">
          分析
        </h2>
        <div className="flex items-center gap-2">
          <fieldset className="flex gap-1">
            <legend className="sr-only">集計期間</legend>
            {ANALYTICS_PERIOD_DAYS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === days ? "secondary" : "outline"}
                aria-pressed={option === days}
                onClick={() => setDays(option)}
              >
                直近{option}日
              </Button>
            ))}
          </fieldset>
          <Button
            size="icon"
            variant="ghost"
            aria-label="分析を再読み込み"
            aria-disabled={isFetching}
            onClick={
              isFetching
                ? undefined
                : () => {
                    void Promise.all([
                      cost.refetch(),
                      approvals.refetch(),
                      leadTime.refetch(),
                    ]);
                  }
            }
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      <AnalyticsSection
        id="analytics-cost-heading"
        title="Claudeの実行"
        failureTitle="実行のコスト"
        emptyMessage="この期間に記録された実行はありません。"
        query={cost}
      >
        {(rows) => <CostReport rows={rows} days={days} />}
      </AnalyticsSection>
      <AnalyticsSection
        id="analytics-approval-heading"
        title="承認"
        failureTitle="承認の統計"
        emptyMessage="この期間に承認の判断はありません。"
        query={approvals}
      >
        {(rows) => <ApprovalReport rows={rows} />}
      </AnalyticsSection>
      <AnalyticsSection
        id="analytics-lead-time-heading"
        title="リードタイム"
        failureTitle="リードタイム"
        emptyMessage="この期間に終端になった作業項目はありません。"
        query={leadTime}
      >
        {(rows) => <LeadTimeReport rows={rows} />}
      </AnalyticsSection>
    </section>
  );
}
