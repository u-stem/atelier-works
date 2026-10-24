// 保留と凍結の解除を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。

import type { ReleaseNotice } from "../lib/writeNotices.ts";
import type {
  FreezeReleaseResult,
  HoldReleaseResult,
} from "./guards/writeResults.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";

type ReleaseDeps<TInput, TResult> = {
  readonly onNotice: (notice: ReleaseNotice) => void;
  readonly run?: (input: TInput) => Promise<TResult>;
};

export function holdReleaseConfig(
  _deps: ReleaseDeps<number, HoldReleaseResult>,
): WriteRunnerConfig<number, HoldReleaseResult> {
  return {
    keyOf: () => "",
    run: (id) =>
      Promise.resolve({
        ok: true,
        status: "already_released",
        hold_id: id,
        was_active: false,
      }),
    invalidates: [],
    onOutcome: () => undefined,
    onStale: () => undefined,
  };
}

export function freezeReleaseConfig(
  _deps: ReleaseDeps<string, FreezeReleaseResult>,
): WriteRunnerConfig<string, FreezeReleaseResult> {
  return {
    keyOf: () => "",
    run: (id) =>
      Promise.resolve({ ok: true, status: "already_ended", freeze_id: id }),
    invalidates: [],
    onOutcome: () => undefined,
    onStale: () => undefined,
  };
}
