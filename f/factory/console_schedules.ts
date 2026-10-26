// Consoleのジョブの画面が読む、scheduleの状態を返すscript(スタブ)。

import type { RepoSchedule } from "./lib/console_known_paths.ts";

export type QueueQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
};

export type SchedulesPorts = {
  readonly listSchedules: () => Promise<readonly unknown[]>;
  readonly listSchedulesWithJobs: () => Promise<readonly unknown[]>;
  readonly listQueue: (query: QueueQuery) => Promise<readonly unknown[]>;
};

export type RecentRun = {
  readonly job_id: string;
  readonly success: boolean;
  readonly duration_ms: number | null;
};

export type ScheduleView = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly summary: string | null;
  readonly no_flow_overlap: boolean;
  readonly paused_until: string | null;
  readonly edited_at: string | null;
  readonly error: string | null;
  readonly next_run_at: string | null;
  readonly recent_runs: readonly RecentRun[];
  readonly definition: "matches" | "differs" | "not_in_repo";
  readonly differences: readonly string[];
};

export type SchedulesSnapshot = {
  readonly schedules: readonly ScheduleView[];
  readonly missing_in_workspace: readonly string[];
};

export async function loadSchedules(
  _ports: SchedulesPorts,
  _repo: readonly RepoSchedule[],
): Promise<SchedulesSnapshot> {
  return { schedules: [], missing_in_workspace: ["stub"] };
}

export async function main(): Promise<SchedulesSnapshot> {
  return { schedules: [], missing_in_workspace: ["stub"] };
}
