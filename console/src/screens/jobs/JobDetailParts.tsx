import type { ReactNode } from "react";
import type {
  ArgViewData,
  JobDetailView,
  JobSummaryView,
  OutputViewData,
  StepViewData,
} from "../../api/jobsQueries.ts";

export type BackState = { readonly jobsBack: string } | undefined;

export function JobOverview(_props: {
  job: JobSummaryView;
  now: number;
  relatedItemId: number | null;
  back: BackState;
}): ReactNode {
  return null;
}

export function ArgList(_props: { args: readonly ArgViewData[] }): ReactNode {
  return null;
}

export function StepList(_props: {
  steps: readonly StepViewData[];
  back: BackState;
}): ReactNode {
  return null;
}

export function OutputSection(_props: {
  id: string;
  title: string;
  kind: "log" | "result";
  output: (OutputViewData & { readonly nonJsonLines?: number }) | null;
  error: string | null;
  emptyText: string;
  onRefresh?: () => void;
  refreshLabel?: string;
  refreshing?: boolean;
}): ReactNode {
  return null;
}

export function FailureCauses(_props: {
  failures: Extract<JobDetailView, { found: true }>["failures"];
  now: number;
  back: BackState;
}): ReactNode {
  return null;
}
