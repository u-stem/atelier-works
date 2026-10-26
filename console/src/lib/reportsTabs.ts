// レポートの画面のタブ(監査レポートと分析)。
// 開くタブはURLの`?tab=`に持ち、監査レポートは名前を持たない。

import type { ResolvedTabSpec, TabSet } from "./tabSet.ts";

export type ReportsTabId = "audit" | "analytics";

export const REPORTS_TABS: TabSet<ReportsTabId> = {
  tabs: [],
  defaultTab: "audit",
  idPrefix: "reports",
};

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は監査レポートにする。 */
export function parseReportsTab(_value: string | null): ReportsTabId {
  return "audit";
}

/** タブを選んだ後のクエリを返す。他のクエリは残す。 */
export function withReportsTab(
  current: URLSearchParams,
  _tab: ReportsTabId,
): URLSearchParams {
  return new URLSearchParams(current);
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function reportsPanelAttrs(
  _panel: ReportsTabId,
  _selected: ReportsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return { id: "", labelledBy: "", hidden: false };
}

/** 共通の`Tabs`へ渡す、2つのタブの指定。 */
export function reportsTabSpecs(
  _selected: ReportsTabId,
  _failed: Readonly<Record<ReportsTabId, boolean>>,
  _auditCount: number | undefined,
): ResolvedTabSpec<ReportsTabId>[] {
  return [];
}
