// 保留と凍結の画面が読む取得。

import type { HoldsSnapshot } from "./guards/holds.ts";
import type { RunScriptOptions } from "./windmill.ts";

export const holdsQueryKey = ["console", "holds-unset"] as const;

export const HOLDS_STALE_MS = 0;

export function fetchHolds(
  _options: RunScriptOptions = {},
): Promise<HoldsSnapshot> {
  return Promise.resolve({
    holds: { ok: true, rows: [] },
    freezes: { ok: true, schedule: [], deploy: [] },
  });
}

export function holdsQueryOptions() {
  return {
    queryKey: holdsQueryKey,
    queryFn: () => fetchHolds(),
    refetchInterval: false as const,
    refetchIntervalInBackground: true,
    staleTime: HOLDS_STALE_MS,
  };
}
