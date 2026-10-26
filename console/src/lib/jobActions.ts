import type { JobSummaryView } from "../api/jobsQueries.ts";

export const CANCELABLE_FLOW_PATHS: readonly string[] = [];
export const DEPENDABOT_FLOW_PATH = "";

export function canCancelJob(
  _job: Pick<
    JobSummaryView,
    "state" | "script_path" | "job_kind" | "parent_job" | "is_flow_step" | "tag"
  >,
): boolean {
  return false;
}

export function cancelDialogLines(_flowPath: string): readonly string[] {
  return [];
}
