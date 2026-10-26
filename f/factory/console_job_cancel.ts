import type { ActionSqlClient } from "./lib/console_actions.ts";

export const CANCELABLE_FLOW_PATHS: readonly string[] = [];
export const NOT_CANCELABLE_FLOW_PATHS: Readonly<Record<string, string>> = {};
export const DEPENDABOT_FLOW_PATH = "";
export const CANCEL_REFUSAL_REASONS: readonly string[] = [];

export type WorkItemView = {
  readonly id: number;
  readonly status: string;
  readonly lease_held: boolean;
};

export type CancelPorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly cancelJob: (id: string) => Promise<void>;
  readonly readWorkItem: (id: number) => Promise<{
    readonly id: number;
    readonly status: string;
    readonly flow_job_id: string | null;
  } | null>;
  readonly sql: ActionSqlClient;
};

export type CancelTarget =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "ok";
      readonly job: {
        readonly id: string;
        readonly flow_path: string;
        readonly state: "running" | "queued";
        readonly work_item_id: number | null;
      };
    };

export function evaluateCancelTarget(_raw: unknown, _now: Date): CancelTarget {
  return { kind: "not_found" };
}

export type JobCancelResult = { readonly found: false };

export async function cancelJobFromConsole(
  _jobId: string,
  _ports: CancelPorts,
): Promise<JobCancelResult> {
  return { found: false };
}

export async function main(job_id: string): Promise<JobCancelResult> {
  void job_id;
  return { found: false };
}
