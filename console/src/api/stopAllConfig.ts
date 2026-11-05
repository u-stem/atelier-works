import type {
  StopAllReleaseResult,
  StopAllResult,
} from "./guards/writeResults.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { releaseStopAll, stopAll } from "./writes.ts";

export function stopAllConfig(
  _deps: unknown,
): WriteRunnerConfig<string, StopAllResult> {
  return {
    keyOf: (reason) => reason,
    run: (reason) => stopAll(reason),
    invalidates: [],
    onOutcome: () => undefined,
    onStale: () => undefined,
  };
}

export function stopAllReleaseConfig(
  _deps: unknown,
): WriteRunnerConfig<null, StopAllReleaseResult> {
  return {
    keyOf: () => "",
    run: () => releaseStopAll(),
    invalidates: [],
    onOutcome: () => undefined,
    onStale: () => undefined,
  };
}
