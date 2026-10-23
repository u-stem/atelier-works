// Consoleの「新規投入」から呼ぶscript。
// 今は仮の実装で、テストが失敗することを確かめるための戻り値だけを返す。

import type { Logger } from "./lib/log.ts";
import type {
  ManualIntakeFields,
  ManualIntakeRefusalReason,
} from "./lib/manual_intake_support.ts";
import type { FactoryConfig } from "./lib/types.ts";

export type ManualIntakeSubmitResult =
  | {
      readonly refused: true;
      readonly reason: ManualIntakeRefusalReason;
    }
  | { readonly refused: false; readonly flow_job_id: string };

export type ManualIntakeSubmitDeps = {
  readonly loadConfig: () => Promise<
    Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">
  >;
  readonly deriveActor: () => string;
  readonly runFlow: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly log: Pick<Logger, "info">;
};

export function submitManualIntake(
  _input: ManualIntakeFields,
  _deps: ManualIntakeSubmitDeps,
): Promise<ManualIntakeSubmitResult> {
  return Promise.resolve({ refused: true, reason: "invalid_owner" });
}
