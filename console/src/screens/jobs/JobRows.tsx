import type { ReactNode } from "react";
import type { JobListView, JobSummaryView } from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import type { LoadingShape } from "../../components/LoadingState.tsx";

export function JobStateBadge(_props: { state: string }): ReactNode {
  return null;
}

export function JobList(_props: {
  jobs: readonly JobSummaryView[];
  now: number;
  back: string;
  time: "active" | "history";
}): ReactNode {
  return null;
}

export function JobsQueryGate<T>(_props: {
  query: SectionQuery<T>;
  title: string;
  loginHint: string;
  shape: LoadingShape;
  children: (data: T) => ReactNode;
}): ReactNode {
  return null;
}

export function ActiveJobs(_props: {
  query: SectionQuery<JobListView>;
}): ReactNode {
  return null;
}
