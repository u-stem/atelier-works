// レポートの画面のタブ(監査レポートと分析)。
// 開くタブはURLの`?tab=`に持ち、監査レポートは名前を持たない。

import {
  parseTab,
  type ResolvedTabSpec,
  type TabSet,
  tabPanelAttrs,
  tabSpecs,
  withTab,
} from "./tabSet.ts";

export type ReportsTabId = "audit" | "analytics";

export const REPORTS_TABS: TabSet<ReportsTabId> = {
  tabs: [
    { id: "audit", label: "監査レポート" },
    { id: "analytics", label: "分析" },
  ],
  defaultTab: "audit",
  idPrefix: "reports",
};

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は監査レポートにする。 */
export function parseReportsTab(value: string | null): ReportsTabId {
  return parseTab(REPORTS_TABS, value);
}

/** タブを選んだ後のクエリを返す。他のクエリは残す。 */
export function withReportsTab(
  current: URLSearchParams,
  tab: ReportsTabId,
): URLSearchParams {
  return withTab(REPORTS_TABS, current, tab);
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function reportsPanelAttrs(
  panel: ReportsTabId,
  selected: ReportsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return tabPanelAttrs(REPORTS_TABS, panel, selected);
}

/**
 * 共通の`Tabs`へ渡す、2つのタブの指定。
 * 件数は監査レポートのタブだけに付ける。印は、隠れているタブの取得が失敗したときだけ付く。
 */
export function reportsTabSpecs(
  selected: ReportsTabId,
  failed: Readonly<Record<ReportsTabId, boolean>>,
  auditCount: number | undefined,
): ResolvedTabSpec<ReportsTabId>[] {
  return tabSpecs(REPORTS_TABS, selected, {
    failed,
    counts: { audit: auditCount },
  });
}
