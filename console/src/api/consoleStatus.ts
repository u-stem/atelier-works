// 配信しているConsoleの版と取り込みの状態を、`/console/status.json`から読む。

import { useQuery } from "@tanstack/react-query";
import {
  type ConsoleStatus,
  parseConsoleStatus,
} from "../lib/consoleStatus.ts";
import type { FetchLike } from "./windmill.ts";

const STATUS_URL = "/console/status.json";

/** 取り直す間隔。取り込みの確認は5分ごとなので、それより細かくは見ない。 */
const STATUS_STALE_MS = 5 * 60_000;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * 状態を読む。取れない、JSONでない、形が違うときは`null`を返し、例外は投げない。
 * 版の表示は補助の情報で、取れなくても画面を止めないためである。
 */
export async function fetchConsoleStatus(
  fetchFn: FetchLike = defaultFetch,
): Promise<ConsoleStatus | null> {
  try {
    const response = await fetchFn(STATUS_URL, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return null;
    }
    return parseConsoleStatus(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

/** サイドバーの下部に出す版の情報。取れなければ`null`のままで、再試行しない。 */
export function useConsoleStatus(): ConsoleStatus | null {
  const query = useQuery({
    queryKey: ["console", "status"],
    queryFn: () => fetchConsoleStatus(),
    staleTime: STATUS_STALE_MS,
    refetchInterval: STATUS_STALE_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return query.data ?? null;
}
