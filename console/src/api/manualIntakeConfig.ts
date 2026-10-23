// 仮の実装。テストが失敗することを確かめるための値だけを返す。

import type { IntakeAttempt } from "../lib/intakeAttempt.ts";
import type { ManualIntakeSubmitResult } from "./guards/writeResults.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import type { ManualIntakeInput } from "./writes.ts";

type ManualIntakeDeps = {
  readonly onAttempt: (attempt: IntakeAttempt) => void;
  readonly onStale: () => void;
  readonly run?: (
    input: ManualIntakeInput,
  ) => Promise<ManualIntakeSubmitResult>;
};

export function manualIntakeConfig(
  _deps: ManualIntakeDeps,
): WriteRunnerConfig<ManualIntakeInput, ManualIntakeSubmitResult> {
  return {
    keyOf: () => "",
    run: () => Promise.resolve({ refused: false, flow_job_id: "" }),
    onOutcome: () => undefined,
    onStale: () => undefined,
  };
}
