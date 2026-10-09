// Consoleが読むデータの取得。取り直しは件数と一覧を持つsummaryだけが自動で行う。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { type ConsoleSummary, isConsoleSummary } from "./guards/summary.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** summaryを取り直す間隔。画面が見えている間だけ動く。 */
export const SUMMARY_REFRESH_MS = 120_000;

/** summaryが新しいとみなす間隔。タブに戻ったときの取得が、定期の取得と重ならないようにする。 */
const SUMMARY_STALE_MS = 30_000;

export const summaryQueryKey = ["console", "summary"] as const;

/** summaryを取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchSummary(
  options: RunScriptOptions = {},
): Promise<ConsoleSummary> {
  const result = await runScript("console_query", { view: "summary" }, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isConsoleSummary(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * summaryを取る。タブが見えない間は取り直さない
 * (`refetchIntervalInBackground`を有効にしない)。
 */
export function useSummary(): UseQueryResult<ConsoleSummary, Error> {
  return useQuery({
    queryKey: summaryQueryKey,
    queryFn: ({ signal }) => fetchSummary({ signal }),
    refetchInterval: SUMMARY_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: SUMMARY_STALE_MS,
  });
}
