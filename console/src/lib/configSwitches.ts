import type { ConfigItemView, DesignStageView } from "../api/jobsQueries.ts";
import type { ChangeOffer } from "./configChange.ts";

export type SwitchState = "on" | "off" | "hidden" | "unset" | "not_boolean";

export type SwitchRow = {
  readonly key: string;
  readonly state: SwitchState;
  readonly stageNote: string | null;
  readonly offer: ChangeOffer | null;
};

export function switchRowsOf(
  _items: readonly ConfigItemView[],
  _designStage: DesignStageView | undefined,
): SwitchRow[] {
  return [];
}

export function switchTableShown(_query: string, _itemCount: number): boolean {
  return false;
}
