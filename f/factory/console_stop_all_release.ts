import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { FreezeReadIo } from "./lib/freezes.ts";
import type { StopAllReadIo } from "./lib/stop_all.ts";

export const STOP_ALL_RELEASE_REFUSAL_REASONS = [
  "state_unreadable",
  "freezes_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllReleaseRefusalReason =
  (typeof STOP_ALL_RELEASE_REFUSAL_REASONS)[number];

export type StopAllReleaseResult =
  | { readonly refused: true; readonly reason: StopAllReleaseRefusalReason }
  | { readonly refused: false; readonly released: false }
  | {
      readonly refused: false;
      readonly released: true;
      readonly schedules_enabled: readonly string[];
      readonly schedules_skipped: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

export type StopAllReleasePorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly stopAll: StopAllReadIo;
  readonly clearStopAll: () => Promise<void>;
  readonly freeze: FreezeReadIo;
  readonly setScheduleEnabled: (
    path: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly sql: ActionSqlClient;
};

export async function releaseStopAllFromConsole(
  _ports: StopAllReleasePorts,
): Promise<StopAllReleaseResult> {
  return { refused: false, released: false };
}

export async function main(): Promise<StopAllReleaseResult> {
  return { refused: false, released: false };
}
