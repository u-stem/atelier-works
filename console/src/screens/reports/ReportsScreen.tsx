import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  useAgentCostDaily,
  useApprovalStats,
  useLeadTime,
} from "../../api/analyticsQueries.ts";
import { useAuditIndex } from "../../api/auditQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOfAll } from "../../app/refreshStatus.ts";
import { TabPanel } from "../../components/TabPanel.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import {
  type AnalyticsPeriodDays,
  DEFAULT_ANALYTICS_DAYS,
} from "../../lib/analytics.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import {
  parseReportsTab,
  REPORTS_TABS,
  type ReportsTabId,
  reportsPanelAttrs,
  reportsTabSpecs,
  withReportsTab,
} from "../../lib/reportsTabs.ts";
import { useTabScroll } from "../../lib/useTabScroll.ts";
import { AnalyticsReports } from "./AnalyticsReports.tsx";
import { AuditReports } from "./AuditReports.tsx";

/**
 * レポートの画面。監査レポートと分析の2つのタブを持つ。
 * 開くタブはURLの`?tab=`に持ち、選び直しても履歴を積まない。
 * 4つの取得と分析の期間は画面が持ち、見出しの更新ボタンが4つを取り直す。タブの切り替えでは取得しない。
 * 選んでいないタブの本体も描いたまま隠し、分析の期間の選択と監査レポートの状態を保つ。
 * 隠れたタブの取得が失敗したときは、タブの名前に失敗の印を付ける。
 */
export function ReportsScreen() {
  const [days, setDays] = useState<AnalyticsPeriodDays>(DEFAULT_ANALYTICS_DAYS);
  const audit = useAuditIndex();
  const cost = useAgentCostDaily(days);
  const approvals = useApprovalStats(days);
  const leadTime = useLeadTime(days);
  const refresh = refreshStatusOfAll([audit, cost, approvals, leadTime]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseReportsTab(searchParams.get("tab"));
  const scroll = useTabScroll(tab);

  // 401は上部のバナーが知らせるので、失敗の印には数えない。
  const failed = {
    audit: refreshStatusOfAll([audit]).isError,
    analytics: refreshStatusOfAll([cost, approvals, leadTime]).isError,
  };
  const tabs = reportsTabSpecs(tab, failed, audit.data?.length);

  const selectTab = (id: ReportsTabId): void => {
    setSearchParams((current) => withReportsTab(current, id), {
      replace: true,
    });
  };

  return (
    <>
      <PageHeader title="レポート" refresh={refresh} />
      <Tabs
        tabs={tabs}
        selected={tab}
        onSelect={selectTab}
        label="レポート"
        idPrefix={REPORTS_TABS.idPrefix}
      />
      <div
        ref={scroll.frameRef}
        onScroll={scroll.onScroll}
        className={SCROLL_BODY_CLASS}
      >
        <TabPanel attrs={reportsPanelAttrs("audit", tab)}>
          <AuditReports query={audit} />
        </TabPanel>
        <TabPanel attrs={reportsPanelAttrs("analytics", tab)}>
          <AnalyticsReports
            days={days}
            onDaysChange={setDays}
            cost={cost}
            approvals={approvals}
            leadTime={leadTime}
          />
        </TabPanel>
      </div>
    </>
  );
}
