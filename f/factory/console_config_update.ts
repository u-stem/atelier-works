import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";

export const BOOLEAN_STOP_ITEMS: readonly string[] = [];

export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {};

export type ConfigUpdateRefusalReason =
  | "item_not_allowed"
  | "invalid_value"
  | "not_lowering"
  | "has_reference"
  | "conflict"
  | "actor_unknown"
  | "audit_unavailable";

export const CONFIG_UPDATE_REFUSAL_REASONS: readonly ConfigUpdateRefusalReason[] =
  [];

export type ConfigUpdateResult =
  | { readonly refused: true; readonly reason: ConfigUpdateRefusalReason }
  | {
      readonly refused: false;
      readonly item: string;
      readonly before: number | boolean;
      readonly after: number | boolean;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

export type ConfigUpdatePorts = {
  readonly deriveActor: () => string;
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (value: Record<string, unknown>) => Promise<void>;
  readonly sql: ActionSqlClient;
};

export async function updateConfigFromConsole(
  _item: string,
  _expected: unknown,
  _next: unknown,
  _ports: ConfigUpdatePorts,
): Promise<ConfigUpdateResult> {
  return { refused: true, reason: "item_not_allowed" };
}

export async function main(
  item: string,
  expected: number | boolean,
  next: number | boolean,
): Promise<ConfigUpdateResult> {
  void [item, expected, next];
  return { refused: true, reason: "item_not_allowed" };
}
