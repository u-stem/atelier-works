export const STOP_ALL_REASON_MAX_LENGTH = 200;

export type StopAllReasonProblem =
  | "reason_empty"
  | "reason_too_long"
  | "reason_has_control";

export function checkStopAllReason(
  _reason: string,
): StopAllReasonProblem | null {
  return null;
}

export function stopAllReasonMessage(_problem: StopAllReasonProblem): string {
  return "";
}

export const STOP_ALL_EFFECT_LINES: readonly string[] = [];

export const STOP_ALL_RELEASE_LINES: readonly string[] = [];
