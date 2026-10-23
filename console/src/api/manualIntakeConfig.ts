// 新規投入を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 投入は対象を持たないので、ロックのキーを1つに固定する。入力の内容でキーを変えると、
// 題名を書き換えるだけで二重に送れてしまう。
// 結果は`onAttempt`に渡す。投入の後は、作業項目の進捗を読み直す。

import {
  attemptFromOutcome,
  type IntakeAttempt,
} from "../lib/intakeAttempt.ts";
import type { ManualIntakeSubmitResult } from "./guards/writeResults.ts";
import { pipelineQueryKey } from "./queries.ts";
import { MANUAL_INTAKE_WRITE_KEY } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { type ManualIntakeInput, submitManualIntake } from "./writes.ts";

type ManualIntakeDeps = {
  /** 送信の結果を画面に残す。 */
  readonly onAttempt: (attempt: IntakeAttempt) => void;
  /** 一覧を読み直せなかったことを画面に残す。 */
  readonly onStale: () => void;
  /** テストで差し替える。既定は`submitManualIntake`。 */
  readonly run?: (
    input: ManualIntakeInput,
  ) => Promise<ManualIntakeSubmitResult>;
};

export function manualIntakeConfig(
  deps: ManualIntakeDeps,
): WriteRunnerConfig<ManualIntakeInput, ManualIntakeSubmitResult> {
  return {
    keyOf: () => MANUAL_INTAKE_WRITE_KEY,
    run: deps.run ?? ((input) => submitManualIntake(input)),
    invalidates: [pipelineQueryKey],
    onOutcome: (outcome) => {
      deps.onAttempt(attemptFromOutcome(outcome));
    },
    onStale: () => {
      deps.onStale();
    },
  };
}
