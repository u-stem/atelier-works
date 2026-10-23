// 新規投入を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 投入は対象を持たないので、ロックのキーを1つに固定する。入力の内容でキーを変えると、
// 題名を書き換えるだけで二重に送れてしまう。
// 結果は、画面の部品ではなく、タブ全体で持つ状態(`intakeSession.ts`)に書く。
// 送信中に画面が外れても、結果が失われないためである。投入の後は、作業項目の進捗を読み直す。

import { attemptFromOutcome } from "../lib/intakeAttempt.ts";
import type { ManualIntakeSubmitResult } from "./guards/writeResults.ts";
import { type IntakeSessions, intakeSessions } from "./intakeSession.ts";
import { pipelineQueryKey } from "./queries.ts";
import { MANUAL_INTAKE_WRITE_KEY } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { type ManualIntakeInput, submitManualIntake } from "./writes.ts";

type ManualIntakeDeps = {
  /** 結果を書く先。既定はタブ全体で共有する状態。テストで差し替える。 */
  readonly sessions?: IntakeSessions;
  /** テストで差し替える。既定は`submitManualIntake`。 */
  readonly run?: (
    input: ManualIntakeInput,
  ) => Promise<ManualIntakeSubmitResult>;
};

export function manualIntakeConfig(
  deps: ManualIntakeDeps = {},
): WriteRunnerConfig<ManualIntakeInput, ManualIntakeSubmitResult> {
  const sessions = deps.sessions ?? intakeSessions;
  return {
    keyOf: () => MANUAL_INTAKE_WRITE_KEY,
    run: deps.run ?? ((input) => submitManualIntake(input)),
    invalidates: [pipelineQueryKey],
    onOutcome: (outcome) => {
      sessions.record(MANUAL_INTAKE_WRITE_KEY, attemptFromOutcome(outcome));
    },
    onStale: () => {
      sessions.markStale(MANUAL_INTAKE_WRITE_KEY);
    },
  };
}
