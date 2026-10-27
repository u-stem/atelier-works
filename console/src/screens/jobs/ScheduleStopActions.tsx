import type { ScheduleFreeze, ScheduleStopState } from "../../lib/holdPlace.ts";

export function ScheduleStopControl(_props: {
  path: string;
  state: ScheduleStopState;
  locked: boolean;
  onPrepare: (path: string) => void;
  onStop: (path: string, freeze: ScheduleFreeze) => void;
}) {
  return null;
}

export function ScheduleStopDialog(_props: {
  target: { readonly path: string; readonly freeze: ScheduleFreeze } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return null;
}
