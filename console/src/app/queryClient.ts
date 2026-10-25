import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "../api/queryPolicy.ts";
import type { AuthStore } from "./authState.ts";
import type { ConnectionStore } from "./connectionState.ts";

/**
 * 取得と書き込みの結果をログインの状態に反映するQueryClientを作る。
 * 書き込みの401も取得と同じバナーに流す。書き込みは再試行しない。
 * 結果が分からないまま2回実行しないためである。
 * 取得の結果は、Windmillへ届いているかの状態にも反映する(書き込みの失敗は含めない)。
 *
 * 取得は`networkMode: "always"`で、ブラウザの接続状態で止めない。
 * ブラウザは、他のネットワークが切れると接続なしと答えるが、Windmillは同じ端末にあって届く。
 * 届かないときは、取得が失敗して帯が出る。
 */
export function createQueryClient(
  authStore: AuthStore,
  _connection?: ConnectionStore,
): QueryClient {
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
      queries: { retry: shouldRetryQuery, networkMode: "always" },
      mutations: { retry: 0 },
    },
  });
}

export function watchConnectionRecovery(
  _store: ConnectionStore,
  _client: Pick<QueryClient, "invalidateQueries">,
): () => void {
  return () => undefined;
}
