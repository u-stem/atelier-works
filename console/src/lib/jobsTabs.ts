// ジョブの画面のタブ(実行中と待ち、履歴、スケジュール)。
// 開くタブはURLの`?tab=`に持ち、実行中と待ちは名前を持たない。

import {
  parseTab,
  type ResolvedTabSpec,
  type TabSet,
  tabPanelAttrs,
  tabSpecs,
  withTab,
} from "./tabSet.ts";

export type JobsTabId = "active" | "history" | "schedules";

export const JOBS_TABS: TabSet<JobsTabId> = {
  tabs: [],
  defaultTab: "active",
  idPrefix: "jobs",
};

export function parseJobsTab(value: string | null): JobsTabId {
  return parseTab(JOBS_TABS, value);
}

export function withJobsTab(
  current: URLSearchParams,
  tab: JobsTabId,
): URLSearchParams {
  return withTab(JOBS_TABS, current, tab);
}

export function jobsPanelAttrs(
  panel: JobsTabId,
  selected: JobsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return tabPanelAttrs(JOBS_TABS, panel, selected);
}

export function jobsTabSpecs(
  selected: JobsTabId,
  _input: {
    readonly failed: Readonly<Record<JobsTabId, boolean>>;
    readonly activeCount: number | undefined;
    readonly activeCountAtLeast: boolean;
  },
): ResolvedTabSpec<JobsTabId>[] {
  return tabSpecs(JOBS_TABS, selected);
}
