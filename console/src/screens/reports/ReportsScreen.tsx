import { useState } from "react";
import {
  useAgentCostDaily,
  useApprovalStats,
  useLeadTime,
} from "../../api/analyticsQueries.ts";
import { useAuditIndex } from "../../api/auditQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOfAll } from "../../app/refreshStatus.ts";
import {
  type AnalyticsPeriodDays,
  DEFAULT_ANALYTICS_DAYS,
} from "../../lib/analytics.ts";
import { AnalyticsReports } from "./AnalyticsReports.tsx";
import { AuditReports } from "./AuditReports.tsx";

/**
 * レポートの画面。監査レポートの一覧と分析を出す。
 * 4つの取得と分析の期間は画面が持ち、見出しの更新ボタンが4つを取り直す。
 */
export function ReportsScreen() {
  const [days, setDays] = useState<AnalyticsPeriodDays>(DEFAULT_ANALYTICS_DAYS);
  const audit = useAuditIndex();
  const cost = useAgentCostDaily(days);
  const approvals = useApprovalStats(days);
  const leadTime = useLeadTime(days);
  const refresh = refreshStatusOfAll([audit, cost, approvals, leadTime]);
  return (
    <>
      <PageHeader title="レポート" refresh={refresh} />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 md:px-8">
        <AuditReports query={audit} />
        <AnalyticsReports
          days={days}
          onDaysChange={setDays}
          cost={cost}
          approvals={approvals}
          leadTime={leadTime}
        />
      </div>
    </>
  );
}
