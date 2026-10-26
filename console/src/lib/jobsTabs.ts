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
  tabs: [
    { id: "active", label: "実行中と待ち" },
    { id: "history", label: "履歴" },
    { id: "schedules", label: "スケジュール" },
  ],
  defaultTab: "active",
  idPrefix: "jobs",
};

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は実行中と待ちにする。 */
export function parseJobsTab(value: string | null): JobsTabId {
  return parseTab(JOBS_TABS, value);
}

/** タブを選んだ後のクエリを返す。履歴の絞り込みなど、他のクエリは残す。 */
export function withJobsTab(
  current: URLSearchParams,
  tab: JobsTabId,
): URLSearchParams {
  return withTab(JOBS_TABS, current, tab);
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function jobsPanelAttrs(
  panel: JobsTabId,
  selected: JobsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return tabPanelAttrs(JOBS_TABS, panel, selected);
}

/**
 * 共通の`Tabs`へ渡す、3つのタブの指定。
 * 件数は実行中と待ちのタブだけに付ける。キューの1ページで切れたときは、下限の印を付ける。
 * 印は、選んでいないタブの取得が失敗したときだけ付く。
 */
export function jobsTabSpecs(
  selected: JobsTabId,
  input: {
    readonly failed: Readonly<Record<JobsTabId, boolean>>;
    readonly activeCount: number | undefined;
    readonly activeCountAtLeast: boolean;
  },
): ResolvedTabSpec<JobsTabId>[] {
  return tabSpecs(JOBS_TABS, selected, {
    failed: input.failed,
    counts: { active: input.activeCount },
    countAtLeast: { active: input.activeCountAtLeast },
  });
}

/** タブごとに、取得を始めてよいか。開いたことのあるタブだけを取得する。 */
export function jobsFetchPlan(
  _visited: ReadonlySet<JobsTabId>,
): Readonly<Record<JobsTabId, boolean>> {
  return { active: true, history: true, schedules: true };
}
