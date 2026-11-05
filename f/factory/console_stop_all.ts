import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { StopAllReadIo } from "./lib/stop_all.ts";

export const STOP_ALL_REFUSAL_REASONS = [
  "invalid_reason",
  "state_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllRefusalReason = (typeof STOP_ALL_REFUSAL_REASONS)[number];

export type StopAllConfigOutcome =
  | "written"
  | "unchanged"
  | "has_reference"
  | "failed";

export type StopAllResult =
  | { readonly refused: true; readonly reason: StopAllRefusalReason }
  | {
      readonly refused: false;
      readonly placed: boolean;
      readonly placed_at: string;
      readonly config: StopAllConfigOutcome;
      readonly disabled_flags: readonly string[];
      readonly schedules_disabled: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

export type StopAllPorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly stopAll: StopAllReadIo;
  readonly writeStopAll: (text: string) => Promise<void>;
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (value: Record<string, unknown>) => Promise<void>;
  readonly setScheduleEnabled: (
    path: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly sql: ActionSqlClient;
};

export function enabledFlags(_config: Record<string, unknown>): string[] {
  return [];
}

export async function stopAllFromConsole(
  _reason: unknown,
  _ports: StopAllPorts,
): Promise<StopAllResult> {
  return { refused: true, reason: "invalid_reason" };
}

export async function main(_reason: string): Promise<StopAllResult> {
  return { refused: true, reason: "invalid_reason" };
}
