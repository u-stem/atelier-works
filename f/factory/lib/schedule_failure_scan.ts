import type { ListCompletedJobsData } from "windmill-client@1.817.0";

export const SCHEDULE_DETECTOR_PATH = "";
export const SCAN_LOOKBACK_MS = 0;
export const SCAN_MAX_WINDOW_MS = 0;
export const SCAN_PAGE_SIZE = 0;
export const SCAN_MAX_PAGES = 0;
export const ERROR_MAX_CHARS = 0;

export type ScheduleFailureJob = {
  readonly id: string;
  readonly scriptPath: string;
  readonly completedAtMs: number;
  readonly completedAt: string;
  readonly canceledByTimeout: boolean;
};

export type BaselineRun = { readonly id: string; readonly startedAtMs: number };

export type ScanWindow = {
  readonly baselineMs: number;
  readonly startedAfterMs: number;
  readonly clamped: boolean;
};

export function baselineRunsQuery(workspace: string): ListCompletedJobsData {
  return { workspace };
}

export function findBaselineRun(_response: unknown): BaselineRun | null {
  return { id: "", startedAtMs: 0 };
}

export function readProcessedUntil(
  _result: unknown,
  _run: BaselineRun,
): number {
  return 0;
}

export function scanWindow(_baselineMs: number, _nowMs: number): ScanWindow {
  return { baselineMs: 0, startedAfterMs: 0, clamped: false };
}

export function failuresQuery(
  workspace: string,
  _startedAfterMs: number,
  _page: number,
): ListCompletedJobsData {
  return { workspace };
}

export function extractScheduleFailures(
  _jobs: readonly unknown[],
  _baselineMs: number,
): { failures: ScheduleFailureJob[]; malformed: number } {
  return { failures: [], malformed: 0 };
}

export function groupByScript(
  _failures: readonly ScheduleFailureJob[],
): Map<string, ScheduleFailureJob[]> {
  return new Map();
}

export function visibilityQuery(
  workspace: string,
  _sinceMs: number,
): ListCompletedJobsData {
  return { workspace };
}

export function hasOtherScheduleJob(_response: unknown): boolean {
  return true;
}

export function scriptHistoryQuery(
  workspace: string,
  _scriptPath: string,
): ListCompletedJobsData {
  return { workspace };
}

export function describeJobError(_job: unknown): string {
  return "";
}

export async function collectPages(
  _listPage: (page: number) => Promise<unknown>,
): Promise<{ jobs: unknown[]; truncated: boolean }> {
  return { jobs: [], truncated: false };
}

export function nextProcessedUntil(
  _failures: readonly ScheduleFailureJob[],
  _runStartedAtMs: number,
): number {
  return 0;
}
