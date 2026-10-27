import type { ConfigItemView } from "../api/jobsQueries.ts";

export const STOPPABLE_SWITCHES: readonly string[] = [];

export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {};

export type ChangeOffer =
  | { readonly kind: "stop"; readonly key: string }
  | {
      readonly kind: "lower";
      readonly key: string;
      readonly current: number;
      readonly rule: NumberRule;
    };

export function changeOfferOf(_item: ConfigItemView): ChangeOffer | null {
  return null;
}

export type NewNumberProblem =
  | "empty"
  | "not_a_number"
  | "not_integer"
  | "too_small"
  | "not_lower";

export type NewNumber =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: NewNumberProblem };

export function parseNewNumber(
  _text: string,
  _offer: Extract<ChangeOffer, { kind: "lower" }>,
): NewNumber {
  return { ok: false, reason: "empty" };
}

export function newValueMessage(_reason: NewNumberProblem): string {
  return "";
}

export function changeDialogLines(_offer: ChangeOffer): readonly string[] {
  return [];
}
