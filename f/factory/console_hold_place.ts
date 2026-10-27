// Consoleから、保留かdeployの保留かscheduleの凍結を1件置くscript。(スタブ)

import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { FreezeIo } from "./lib/freezes.ts";
import type {
  HoldReadOutcome,
  HoldRow,
  Outcome,
  RawPlaceInput,
} from "./lib/holds.ts";

export const PLACE_KINDS = ["merge", "deploy", "freeze"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export const PLACE_REFUSAL_REASONS = [
  "invalid_kind",
  "invalid_target",
  "invalid_minutes",
  "invalid_reason",
  "target_not_allowed",
  "already_active",
  "other_holder_active",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type PlaceRefusalReason = (typeof PLACE_REFUSAL_REASONS)[number];

export type PlaceResult =
  | { readonly refused: true; readonly reason: PlaceRefusalReason }
  | {
      readonly refused: false;
      readonly kind: PlaceKind;
      readonly id: string;
      readonly target: string;
      readonly created_at: string;
      readonly expires_at: string;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

export type PlacePorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly listActiveHolds: (
    target: string,
  ) => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly placeHold: (
    input: RawPlaceInput,
  ) => Promise<Outcome<{ readonly id: number }>>;
  readonly freeze: FreezeIo;
  readonly newFreezeId: () => string;
  readonly sql: ActionSqlClient;
};

export async function placeFromConsole(
  _kind: unknown,
  _target: unknown,
  _minutes: unknown,
  _reason: unknown,
  _ports: PlacePorts,
): Promise<PlaceResult> {
  return { refused: true, reason: "invalid_kind" };
}

export async function main(
  _kind: string,
  _target: string,
  _minutes: number,
  _reason: string,
): Promise<PlaceResult> {
  return { refused: true, reason: "invalid_kind" };
}
