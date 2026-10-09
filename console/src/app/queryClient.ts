import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "../api/queryPolicy.ts";
import type { AuthStore } from "./authState.ts";

/**
 * 取得と書き込みの結果をログインの状態に反映するQueryClientを作る。
 * 書き込みの401も取得と同じバナーに流す。書き込みは再試行しない。
 * 結果が分からないまま2回実行しないためである。
 */
export function createQueryClient(authStore: AuthStore): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        authStore.reportError(error);
      },
      onSuccess: () => {
        authStore.reportSuccess();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        authStore.reportError(error);
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: 0 },
    },
  });
}
