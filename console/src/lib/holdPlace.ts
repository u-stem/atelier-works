// 保留と凍結を置く操作と、scheduleを止める操作の、入力の検査と確認の文。(スタブ)

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { HoldPlaceInput } from "../api/writes.ts";

export type PlaceKind = "merge" | "deploy" | "freeze";

export const PLACE_KINDS: readonly PlaceKind[] = [];

export const PLACE_KIND_LABELS: Readonly<Record<PlaceKind, string>> = {
  merge: "",
  deploy: "",
  freeze: "",
};

export const MAX_MINUTES: Readonly<Record<PlaceKind, number>> = {
  merge: 0,
  deploy: 0,
  freeze: 0,
};

export const REASON_MAX_LENGTH = 0;

export type PlaceForm = {
  readonly kind: PlaceKind;
  readonly target: string;
  readonly minutesText: string;
  readonly reason: string;
};

export type PlaceProblem =
  | "target_empty"
  | "target_invalid"
  | "minutes_empty"
  | "minutes_not_integer"
  | "minutes_too_small"
  | "minutes_too_large"
  | "reason_empty"
  | "reason_too_long"
  | "reason_has_control";

export type PlaceCheck =
  | { readonly ok: true; readonly input: HoldPlaceInput }
  | { readonly ok: false; readonly problem: PlaceProblem };

export function checkPlaceForm(_form: PlaceForm): PlaceCheck {
  return { ok: false, problem: "target_empty" };
}

export function placeProblemMessage(
  _problem: PlaceProblem,
  _kind: PlaceKind,
): string {
  return "";
}

export function placeEffectLines(_kind: PlaceKind): readonly string[] {
  return [];
}

/** 止められるscheduleのパス。 */
export const STOP_TARGETS: readonly string[] = [];

/** 止めたときの影響を伝える文。止められないscheduleは`null`。 */
export function stopImpactNote(_path: string): string | null {
  return null;
}

/** 凍結を置いてから、止められるまでの待ち(分)。 */
export const STOP_READY_AFTER_MINUTES = 0;

/** 凍結を置いた時刻から、止められるようになる時刻(ミリ秒)。 */
export function stopReadyAt(_createdAtIso: string): number {
  return 0;
}

export type ScheduleFreeze = {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type ScheduleStopState =
  | { readonly kind: "none" }
  | { readonly kind: "prepare" }
  | {
      readonly kind: "waiting";
      readonly readyAt: number;
      readonly freeze: ScheduleFreeze;
    }
  | { readonly kind: "ready"; readonly freeze: ScheduleFreeze };

export function scheduleStopState(
  _path: string,
  _enabled: boolean,
  _holds: HoldsSnapshot | undefined,
  _nowMs: number,
): ScheduleStopState {
  return { kind: "none" };
}

export function stopDialogLines(
  _path: string,
  _freezeExpiresAt: string,
): readonly string[] {
  return [];
}

export function prepareDialogLines(_path: string): readonly string[] {
  return [];
}
