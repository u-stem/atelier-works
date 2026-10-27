import type {
  HoldPlaceResult,
  ScheduleStopResult,
} from "../../api/guards/writeResults.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import type { HoldPlaceInput } from "../../api/writes.ts";
import type { PlaceForm } from "../../lib/holdPlace.ts";

export function initialPlaceForm(
  _variant: "any" | "stop_prepare",
  _schedulePath = "",
): PlaceForm {
  return { kind: "merge", target: "", minutesText: "", reason: "" };
}

export const PLACE_HOLD: WriteRunnerConfig<HoldPlaceInput, HoldPlaceResult> = {
  keyOf: () => "",
  run: () => Promise.reject(new Error("not implemented")),
  onOutcome: () => undefined,
  onStale: () => undefined,
};

export const STOP_SCHEDULE: WriteRunnerConfig<string, ScheduleStopResult> = {
  keyOf: () => "",
  run: () => Promise.reject(new Error("not implemented")),
  onOutcome: () => undefined,
  onStale: () => undefined,
};
