import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";

export type RerunTarget = {
  readonly schedule_path: string;
  readonly script_path: string;
  readonly timeout_sec: number;
};

export const RERUNNABLE_SCHEDULES: readonly RerunTarget[] = [];

export const NOT_RERUNNABLE_SCHEDULES: Readonly<Record<string, string>> = {};

export type RerunRefusalReason =
  | "not_scheduled"
  | "not_allowed"
  | "not_failed"
  | "not_finished"
  | "already_running"
  | "next_run_soon"
  | "schedule_disabled"
  | "schedule_changed"
  | "args_have_reference"
  | "actor_unknown"
  | "audit_unavailable";

export const RERUN_REFUSAL_REASONS: readonly RerunRefusalReason[] = [];

export type JobRerunResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: RerunRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      readonly job_id: string;
      readonly script_path: string;
      readonly action_audit: ActionAudit;
    };

export type RerunPorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly listQueue: (scriptPath: string) => Promise<readonly unknown[]>;
  readonly getSchedule: (path: string) => Promise<unknown>;
  readonly runScript: (
    path: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly sql: ActionSqlClient;
};

export type RerunJobTarget =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly reason: RerunRefusalReason }
  | {
      readonly kind: "ok";
      readonly job: { readonly id: string; readonly target: RerunTarget };
    };

export function evaluateRerunTarget(_raw: unknown): RerunJobTarget {
  return { kind: "not_found" };
}

export function evaluateQueue(
  _queue: readonly unknown[],
  _target: RerunTarget,
  _now: Date,
): "already_running" | "next_run_soon" | null {
  return "already_running";
}

export type ScheduleCheck =
  | { readonly kind: "ok"; readonly args: Readonly<Record<string, unknown>> }
  | { readonly kind: "refused"; readonly reason: RerunRefusalReason };

export function evaluateSchedule(
  _raw: unknown,
  _target: RerunTarget,
): ScheduleCheck {
  return { kind: "refused", reason: "schedule_changed" };
}

export async function rerunJobFromConsole(
  _jobId: string,
  _ports: RerunPorts,
): Promise<JobRerunResult> {
  return { found: false };
}

export async function main(job_id: string): Promise<JobRerunResult> {
  void job_id;
  return { found: false };
}
