import type { ReactNode } from "react";
import type { JobListView } from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import type { HistoryStatus } from "../../lib/jobsView.ts";

export type HistoryData = {
  readonly pages: readonly JobListView[];
  readonly first: SectionQuery<JobListView>;
  readonly more: SectionQuery<JobListView> | null;
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  readonly refresh: () => void;
};

export function useJobHistory(
  _filter: { readonly status?: string; readonly scriptPath?: string },
  _enabled: boolean,
): HistoryData {
  throw new Error("not implemented");
}

export function JobHistory(_props: {
  history: HistoryData;
  status: HistoryStatus | undefined;
  script: string | undefined;
  scripts: readonly string[];
  onStatusChange: (status: HistoryStatus | undefined) => void;
  onScriptChange: (script: string | undefined) => void;
  search: string;
}): ReactNode {
  return null;
}
