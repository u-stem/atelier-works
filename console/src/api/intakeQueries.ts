// 仮の実装。テストが失敗することを確かめるための値だけを返す。

import type { IntakeTarget } from "./guards/intakeTargets.ts";
import type { RunScriptOptions } from "./windmill.ts";

export const intakeTargetsQueryKey: readonly string[] = ["console", "unset"];

export function fetchIntakeTargets(
  _options: RunScriptOptions = {},
): Promise<IntakeTarget[]> {
  return Promise.resolve([]);
}
