import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import {
  KNOWN_FLOW_PATHS,
  KNOWN_SCRIPT_PATHS,
} from "../../../../f/factory/lib/console_known_paths.ts";
import { holdsQueryOptions } from "../../api/holdsQueries.ts";
import { useActiveJobs, useSchedules } from "../../api/jobsQueries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import {
  type RefreshStatus,
  refreshStatusOf,
  refreshStatusOfAll,
} from "../../app/refreshStatus.ts";
import { TabPanel } from "../../components/TabPanel.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import {
  JOBS_TABS,
  type JobsTabId,
  jobsPanelAttrs,
  jobsTabSpecs,
  parseJobsTab,
  withJobsTab,
} from "../../lib/jobsTabs.ts";
import {
  type HistoryStatus,
  parseHistoryScript,
  parseHistoryStatus,
  withHistoryScript,
  withHistoryStatus,
} from "../../lib/jobsView.ts";
import { SCROLL_BODY_CLASS } from "../../lib/layoutClasses.ts";
import { useTabScroll } from "../../lib/useTabScroll.ts";
import { useVisitedTabs } from "../../lib/useVisitedTabs.ts";
import { JobHistory, useJobHistory } from "./JobHistory.tsx";
import { ActiveJobs } from "./JobRows.tsx";
import { ScheduleList } from "./ScheduleList.tsx";

/** 履歴の絞り込みに出す、既知のscriptとフローのパス。 */
const KNOWN_PATHS: readonly string[] = [
  ...KNOWN_SCRIPT_PATHS,
  ...KNOWN_FLOW_PATHS,
].sort();

/**
 * ジョブの画面。実行中と待ち、履歴、スケジュールの3つのタブを持つ。
 * 開くタブはURLの`?tab=`に、履歴の絞り込みは`?status=`と`?script=`に持ち、選び直しても履歴を積まない。
 * scriptの値はURLから来るので、既知のscriptの集合と照合し、知らない値は無視する。
 * どの一覧も自動では取り直さない。Console用workerの枠が1つで、一覧の取得が承認などの呼び出しを待たせるためである。
 * 取得は、タブを初めて開いたときに始める。見出しの更新ボタンは、今開いているタブの取得だけを取り直す。
 * スケジュールの凍結の突き合わせに使う保留と凍結の取得は、定期の取り直しをせず、そのタブの更新で取り直す。
 */
export function JobsScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseJobsTab(searchParams.get("tab"));
  const status = parseHistoryStatus(searchParams.get("status"));
  const script = parseHistoryScript(searchParams.get("script"), KNOWN_PATHS);
  const visited = useVisitedTabs(tab);
  const scroll = useTabScroll(tab);

  const active = useActiveJobs(visited.has("active"));
  const history = useJobHistory(
    {
      ...(status === undefined ? {} : { status }),
      ...(script === undefined ? {} : { scriptPath: script }),
    },
    visited.has("history"),
  );
  const schedules = useSchedules(visited.has("schedules"));
  const holds = useQuery({
    ...holdsQueryOptions(),
    refetchInterval: false,
    enabled: visited.has("schedules"),
  });

  const historyRefresh: RefreshStatus = refreshStatusOfAll([
    {
      dataUpdatedAt: history.first.dataUpdatedAt ?? 0,
      isFetching:
        history.first.isFetching || (history.more?.isFetching ?? false),
      isError: history.first.isError,
      error: history.first.error,
      refetch: () => {
        history.refresh();
        return Promise.resolve();
      },
    },
  ]);
  const refresh =
    tab === "history"
      ? historyRefresh
      : tab === "schedules"
        ? refreshStatusOfAll([schedules, holds])
        : refreshStatusOf(active);

  // 401は上部のバナーが知らせるので、失敗の印には数えない。
  const failed = {
    active: refreshStatusOf(active).isError,
    history: historyRefresh.isError,
    schedules: refreshStatusOfAll([schedules]).isError,
  };
  const tabs = jobsTabSpecs(tab, {
    failed,
    activeCount: active.data?.jobs.length,
    activeCountAtLeast: active.data?.truncated === true,
  });

  const selectTab = (id: JobsTabId): void => {
    setSearchParams((current) => withJobsTab(current, id), { replace: true });
  };
  const selectStatus = (next: HistoryStatus | undefined): void => {
    setSearchParams((current) => withHistoryStatus(current, next), {
      replace: true,
    });
  };
  const selectScript = (next: string | undefined): void => {
    setSearchParams((current) => withHistoryScript(current, next), {
      replace: true,
    });
  };

  const search = searchParams.size === 0 ? "" : `?${searchParams.toString()}`;

  return (
    <>
      <PageHeader
        title="ジョブ"
        refresh={refresh}
        refreshLabel={
          tab === "history"
            ? "履歴を先頭から更新"
            : tab === "schedules"
              ? "スケジュールを更新"
              : "実行中と待ちを更新"
        }
      />
      <Tabs
        tabs={tabs}
        selected={tab}
        onSelect={selectTab}
        label="ジョブ"
        idPrefix={JOBS_TABS.idPrefix}
      />
      <div
        ref={scroll.frameRef}
        onScroll={scroll.onScroll}
        className={SCROLL_BODY_CLASS}
      >
        <TabPanel
          attrs={jobsPanelAttrs("active", tab)}
          mounted={visited.has("active")}
        >
          <ActiveJobs query={active} />
        </TabPanel>
        <TabPanel
          attrs={jobsPanelAttrs("history", tab)}
          mounted={visited.has("history")}
        >
          <JobHistory
            history={history}
            status={status}
            script={script}
            scripts={KNOWN_PATHS}
            onStatusChange={selectStatus}
            onScriptChange={selectScript}
            search={search}
          />
        </TabPanel>
        <TabPanel
          attrs={jobsPanelAttrs("schedules", tab)}
          mounted={visited.has("schedules")}
        >
          <ScheduleList schedules={schedules} holds={holds} />
        </TabPanel>
      </div>
    </>
  );
}
