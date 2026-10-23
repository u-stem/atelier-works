// 共通の保留(hold)の表`factory.holds`を読み書きする。

import type { SqlClient, SqlRow } from "./db.ts";

export const HOLD_SCOPES = ["merge", "claim"] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];

export const HOLDER_KINDS = ["session", "human", "factory"] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export const HOLD_MAX_TTL_MINUTES = 24 * 60;
export const HOLD_REASON_MAX = 200;
export const HOLD_HOLDER_MAX = 100;

export const HOLD_ALREADY_ACTIVE = "";

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export type HoldReadFailureKind = "missing_table" | "read_failed" | "corrupt";

export type HoldReadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: HoldReadFailureKind;
      readonly reason: string;
    };

export type HoldRow = {
  readonly id: number;
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly released_by: string | null;
};

export type HoldActor = {
  readonly kind: HolderKind;
  readonly holder: string;
};

export type RawPlaceInput = {
  readonly scope: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: string;
  readonly holder: string;
  readonly minutes: number;
};

export type PlaceInput = {
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly minutes: number;
};

export type HoldFilter = {
  readonly scope?: HoldScope;
  readonly target?: string;
};

export function isActiveHold(
  _row: Pick<HoldRow, "created_at" | "expires_at" | "released_at">,
  _now: Date,
): boolean {
  return false;
}

export function validatePlaceInput(_raw: RawPlaceInput): Outcome<PlaceInput> {
  return { ok: false, reason: "" };
}

export function canRelease(
  _actor: HoldActor,
  _hold: Pick<HoldRow, "holder">,
): boolean {
  return false;
}

export function parseHoldRow(_row: SqlRow): Outcome<HoldRow> {
  return { ok: false, reason: "" };
}

export function isUndefinedTableError(_err: unknown): boolean {
  return false;
}

export async function listActiveHolds(
  _filter: HoldFilter,
  _sql: SqlClient,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  return { ok: true, value: [] };
}

export async function listInvalidHolds(
  _filter: HoldFilter,
  _sql: SqlClient,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  return { ok: true, value: [] };
}

export async function placeHold(
  _input: PlaceInput,
  _sql: SqlClient,
): Promise<Outcome<{ readonly id: number }>> {
  return { ok: false, reason: "" };
}

export async function releaseHold(
  _id: number,
  _actor: HoldActor,
  _sql: SqlClient,
): Promise<Outcome<{ readonly id: number }>> {
  return { ok: false, reason: "" };
}
