// 手動投入で選べるリポジトリの取得。設定の値は変わりにくいので、画面を開いたときに取る。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { type IntakeTarget, isIntakeTargets } from "./guards/intakeTargets.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 候補を取り直さない間隔。許可の設定は、画面を開いている間に変わる量が小さい。 */
const INTAKE_TARGETS_STALE_MS = 60_000;

export const intakeTargetsQueryKey = ["console", "intake_targets"] as const;

/** 手動投入で選べるリポジトリを取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchIntakeTargets(
  options: RunScriptOptions = {},
): Promise<IntakeTarget[]> {
  const result = await runScript(
    "console_query",
    { view: "intake_targets" },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isIntakeTargets(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

export function useIntakeTargets(): UseQueryResult<IntakeTarget[], Error> {
  return useQuery({
    queryKey: intakeTargetsQueryKey,
    queryFn: ({ signal }) => fetchIntakeTargets({ signal }),
    staleTime: INTAKE_TARGETS_STALE_MS,
  });
}
