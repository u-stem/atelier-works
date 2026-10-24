// 保留と凍結の画面が読む取得。有効な保留と凍結は、`console_holds`の1回の取得で揃う。
// 保留は期限で自然に終わるので、画面が見えている間は定期に取り直す。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { type HoldsSnapshot, isHoldsSnapshot } from "./guards/holds.ts";
import { SUMMARY_REFRESH_MS } from "./queries.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

export const holdsQueryKey = ["console", "holds"] as const;

/** タブに戻ったときに取り直さない間隔。定期の取得と重ならないようにする。 */
export const HOLDS_STALE_MS = 30_000;

/** 有効な保留と凍結を取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchHolds(
  options: RunScriptOptions = {},
): Promise<HoldsSnapshot> {
  const result = await runScript("console_holds", {}, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isHoldsSnapshot(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * 取得の設定。summaryと同じ間隔で取り直し、タブが見えない間は取り直さない。
 * 解除した後は、書き込みの共通の流れがこのキーを読み直す。
 */
export function holdsQueryOptions() {
  return {
    queryKey: holdsQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchHolds({ signal }),
    refetchInterval: SUMMARY_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: HOLDS_STALE_MS,
  };
}

/** 有効な保留と凍結を取る。 */
export function useHolds(): UseQueryResult<HoldsSnapshot, Error> {
  return useQuery(holdsQueryOptions());
}
